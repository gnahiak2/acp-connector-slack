# Slack setup

## Create the app

1. Open the Slack app management page and choose **Create New App → From an app manifest**.
2. Paste [slack-app-manifest.json](../slack-app-manifest.json). Adjust name and colours as needed.
3. Under **Socket Mode**, enable it and create an app-level token with the `connections:write` scope. This is `SLACK_APP_TOKEN`.
4. Install the app to the workspace. `SLACK_BOT_TOKEN` starts with `xoxb-`.
5. Invite the bot to each channel that should use it.

Socket Mode is used for both local and server deployments, so no public Slack webhook endpoint is required. The bot still makes outbound Web API calls.

Required bot scopes in the manifest are intentionally minimal: mention read, channel/group/DM history, DM write, chat write and slash commands. Add scopes only if you extend the bridge.

## Configure

```dotenv
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_ALLOWED_USERS=U01234567,U07654321
SLACK_ALLOWED_CHANNELS=C01234567
# Optional defaults
SLACK_DEFAULT_AGENT=fake
SLACK_DEFAULT_PROJECT=my-project
```

`SLACK_ALLOWED_USERS` and `SLACK_ALLOWED_CHANNELS` are fail-closed. An empty list denies every request. `*` allows all and is not recommended. Direct messages are gated by the user allowlist; channel allowlists apply to channels and private groups.

## Routing

- A channel mention without an existing session creates a Slack session rooted at the message thread.
- Replies in a registered thread continue that session. Unregistered thread replies are ignored.
- DMs are gated by the user allowlist. The first DM creates a session; later DMs use the latest DM session or the thread root.
- Bot messages, unsupported message subtypes and duplicate Slack deliveries are ignored.
- A job is persisted before acknowledgement where possible. Duplicate deliveries are deduplicated by Slack event/message identity and a queue-level dedupe key.

Sessions persist the team, channel and thread timestamp, creator, agent, project and access policy. Access is checked again on every prompt, approval and dashboard operation.

## Commands

`/slackboard` provides bridge actions. Agent-provided commands discovered through ACP are separate and are not executed as bridge commands.

| Command | Effect |
| --- | --- |
| `/slackboard help` | Show command help |
| `/slackboard start [agent] [project]` | Set channel defaults, create a thread and session |
| `/slackboard status [session-id]` | Show status, agent, project and pending approvals |
| `/slackboard stop [session-id]` | Cancel the turn and stop the agent |
| `/slackboard agents` | List enabled agent profiles |
| `/slackboard projects` | List active projects |
| `/slackboard skill list` | List enabled skills and attachment state |
| `/slackboard skill use <slug>` | Attach an enabled skill to the latest session |
| `/slackboard skill off <slug>` | Detach a skill |
| `/slackboard memory list` | List project memory |
| `/slackboard memory save <text>` | Explicitly save active project memory |
| `/slackboard approvals` | Show pending approvals for the session |
| `/slackboard doctor [agent]` | Run the ACP connection doctor |

## Streaming and output

- Agent message chunks are throttled into Slack message updates (default 800 ms).
- Messages split at safe boundaries with code fences closed and reopened across posts.
- Slack mention and link syntax is escaped by default so agent output cannot ping users or channels.
- Agent thought chunks are never published or persisted as events.
- Tool calls appear as compact progress context. Approval requests use Block Kit with the exact ACP option names.
- Final status and error states are posted explicitly.
- Rate-limit responses are retried with Slack's `Retry-After` when provided, with bounded attempts.

## Approvals

An approval is bound to the session, job, tool call, exact option IDs and an expiry. A decision is applied with a single atomic update; a second click receives a conflict. Only users allowed by the deployment, channel, project and session policies may resolve it. Expiry cancels the agent's permission request. A stale approval cannot authorise a later tool call.

## Troubleshooting

- `Slack connected` false: verify the app token has `connections:write` and Socket Mode is enabled.
- Every request denied: allowlists are empty or do not contain the user/channel id.
- No replies in a thread: the session was not registered; start one with `/slackboard start` or a mention.
- Missing tool actions: the agent may not issue permission requests; Slackboard only renders options the agent advertises.
