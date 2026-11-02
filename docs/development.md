# Development and verification

## Prerequisites

- Node.js 24+
- pnpm 12
- git
- Docker for container-runner tests/deployment

```bash
pnpm install
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

`pnpm dev` runs the backend with `tsx watch`. `pnpm dev:web` runs Vite on port 5173 with an `/api` proxy to 8787.

## Layout

```
apps/server/src
  api/            Fastify routes, auth/CSRF/origin guards, SSE
  core/           sessions, queue, approvals, agent manager, workspace, memory, skills
  db/             node:sqlite database, migrations, repositories
  slack/          Socket Mode bridge, chunking, streaming, Block Kit
apps/web/src      React dashboard, API client, SSE hook, component tests
packages/acp      ACP SDK client, fs containment, terminals, MCP filtering, doctor
packages/runner   local and Docker execution
packages/skills   SKILL.md parser/renderer
packages/integrations  GitHub App and MCP validation
packages/shared   config, domain types, public events
tests/fixtures    controllable fake ACP subprocess
```

## Test fixture

`tests/fixtures/fake-acp-agent.mjs` implements ACP v1 over stdio. Environment flags select behaviour:

| Flag | Effect |
| --- | --- |
| `FAKE_LOAD=1` | Advertise `loadSession`/`resume`; replay history on load |
| `FAKE_AUTH_REQUIRED=1` | Return `-32000` for session creation/prompt |
| `FAKE_AUTH_METHODS=1` | Advertise agent and terminal auth methods |
| `FAKE_PERMISSION=1` | Request a permission decision and report the chosen option |
| `FAKE_HANG=1` or `--hang` argument | Hold the prompt until `session/cancel` |
| `FAKE_CRASH=1` | Exit during the prompt |
| `FAKE_FS_PATH=<absolute>` | Request an `fs/read_text_file` callback |
| `FAKE_TERMINAL=1` | Create/wait/read/release a terminal |
| `FAKE_MALFORMED=1` | Emit one malformed stdout line |

The protocol tests spawn this fixture through the real `LocalRunner` and the official SDK. They cover streaming, typed updates, exact permission choices, invalid options, cancellation, crash, auth-required, load/replacement, containment, terminals and malformed output.

## Adding an agent

1. Verify the agent's exact invocation manually and run it once outside Slackboard.
2. Add its executable, argument array and environment variable *names* to `config/agents.json` or the dashboard.
3. Run **Agents → Doctor** and record the negotiated protocol version, capabilities and auth methods.
4. Start a disposable session and exercise a prompt, a tool call requiring approval, cancellation and restart.
5. Do not add a named preset until this is repeated with a recorded version and documented invocation.

## Adding a skill

Create `skills/<slug>/SKILL.md` with YAML frontmatter:

```markdown
---
name: my-skill
description: What this skill does and when to use it.
version: 1.0.0
---

Instructions for the agent.
```

Optional reference files go under `skills/<slug>/references/`. They must be relative text paths; symlinks and traversal are rejected/ignored. Scripts are never executed. Skills are injected into the prompt as labelled reference context, not as a system prompt.

## Manual verification checklist

Automated coverage is not a substitute for live checks:

- [ ] Create a Slack app from the manifest, install it, connect Socket Mode
- [ ] Run `/slackboard start`, reply in the thread, observe streamed output
- [ ] Trigger a permission request and resolve it in Slack; verify a second click cannot apply
- [ ] Verify the dashboard shows the same session, status and events
- [ ] Attach a skill and confirm the next prompt's context event lists it
- [ ] Save memory explicitly, then inspect the injection context event
- [ ] Stop a running turn and confirm no agent process/container remains
- [ ] Restart the service during a turn and confirm it is marked interrupted, not replayed
- [ ] Run the doctor against at least two independently implemented ACP agents
- [ ] In server mode, verify container non-root/resource/mount boundaries and network policy
- [ ] Back up and restore the database and workspaces
- [ ] Configure a GitHub App, request a draft PR, approve it, and verify branch/commit/PR; confirm no merge/force-push path exists
- [ ] Keyboard-only dashboard pass and 320 px viewport overflow check
- [ ] Confirm no secrets in `docker logs`, the audit log, events or API responses

Record exact agent versions, commands and any unavailable credentials/tests in your deployment notes.

## Known limitations

- No live Slack or real ACP agent was available while building this copy; those results must be produced in your environment.
- Browser keyboard/mobile automation is not included; dashboard checks are component-level.
- Remote ACP transports and native agent skill conventions are not implemented.
- GitHub draft-PR publication adds/modifies files from the session workspace but does not publish deletions.
- The dashboard supports one admin credential and one Slack installation per deployment.
