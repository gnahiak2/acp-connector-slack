# Slackboard

Self-hosted Slack coding-agent bridge and operations dashboard. Slack is the first chat transport; the transport boundary is isolated so another transport can be added without changing session orchestration.

- Persistent sessions keyed by Slack team/channel/thread (and dashboard-created sessions)
- ACP agent subprocesses over stdio JSON-RPC, using the official TypeScript SDK
- Durable SQLite job queue and ordered event log with SSE replay
- Exact ACP permission options bound to session, requester, tool call and expiry
- Curated project memory, versioned `SKILL.md` skills, MCP configuration, GitHub App draft-PR workflow
- Operation-first React dashboard served same-origin by the backend
- Local trusted runner and isolated-container runner from the same codebase

## Status

This repository is a complete first implementation with unit, protocol, backend and dashboard component tests. The following were exercised locally:

- the full HTTP API, dashboard auth/CSRF/origin checks, session creation, prompt execution, event replay and SSE
- a controllable fake ACP subprocess for streaming, typed updates, permission selection, invalid option rejection, cancellation, crash, authentication-required, session load/replacement, filesystem containment, terminal callbacks and malformed stdout
- the fake agent driving a real dashboard-created session through the job queue and SQLite event log
- Docker image build and container smoke check (health, static dashboard, login)

Not verified in this working copy because credentials were unavailable:

- a live Slack workspace and real Slack Socket Mode connection
- any real ACP agent binary beyond the test fixture
- a real GitHub App installation or draft-PR creation
- automated browser accessibility/mobile checks (component tests only)

Do not treat unverified integrations as production-ready without running the connection doctor and the deployment checks in [docs/development.md](docs/development.md).

## Architecture

```
Slack (Socket Mode) ─┐
                     ├─ Slack bridge ── sessions/jobs ── ACP client ── agent subprocess
Dashboard (React) ───┘         │                              │
                               ├── SQLite (WAL)               ├── filesystem callbacks (contained)
                               ├── event log + SSE            └── terminal callbacks (bounded)
                               └── approvals queue
```

Workspace layout:

- `apps/server` — Fastify service, API/SSE, Slack bridge, orchestration, SQLite repositories
- `apps/web` — React/Vite dashboard
- `packages/acp` — official ACP SDK client, containment, terminal lifecycle, capability gating, doctor
- `packages/runner` — trusted-local and Docker container execution
- `packages/skills` — `SKILL.md` parsing, validation, versioning and context rendering
- `packages/integrations` — MCP configuration validation and GitHub App client
- `packages/shared` — validated configuration, domain and event types
- `skills/` — bundled code review, failing-test investigation and PR preparation skills

## Requirements

- Node.js 24 LTS or newer
- pnpm 12
- SQLite is provided by Node's built-in `node:sqlite`; no native database build is required
- Docker only for the container runner / container deployment

## Quick start (local, trusted runner)

```bash
cp .env.example .env
# Set ADMIN_PASSWORD and, if using Slack, the Slack tokens and allowlists.
cp config/agents.example.json config/agents.json
# Edit config/agents.json with a verified executable and argument array, then set enabled true.
pnpm install
pnpm build
ADMIN_PASSWORD='a-long-random-password' pnpm dev
```

Open `http://127.0.0.1:8787`. In local development you can run Vite separately with `pnpm dev:web`; it proxies `/api` to port 8787.

The local runner is explicitly trusted. ACP path checks constrain the client's own filesystem callbacks, but an agent with shell access can escape them. Use server mode and containers for untrusted agents or repositories.

## Slack setup

1. Create a Slack app from [slack-app-manifest.json](slack-app-manifest.json).
2. Enable Socket Mode and create an app-level token with `connections:write`.
3. Install the app to your workspace and invite it to the allowed channels.
4. Set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_ALLOWED_USERS` and `SLACK_ALLOWED_CHANNELS`.
5. Restart Slackboard. The dashboard health panel should show `Slack connected`.
6. In an allowed channel, run `/slackboard start`, then reply in the created thread or mention the bot.

Empty allowlists deny every Slack request by design. See [docs/slack.md](docs/slack.md).

## Agents

Agents are profiles with an explicit executable, argument array and allowlisted environment variable names. Slack can select a profile but can never submit a command string.

Use the dashboard **Agents** page or `config/agents.json`. Run **Doctor** before enabling a profile. This release ships no claimed agent presets; verify the exact invocation and ACP capabilities yourself.

Authentication that requires a browser or interactive terminal remains an operator setup step. Slackboard does not publish authentication URLs or credentials in Slack.

## Dashboard

- Sessions: filterable table, live event timeline, workspace diff/file inspector, cancel/stop, prompt input
- Approvals: exact ACP options, expiry, one-time atomic resolution
- Agents: profile CRUD, enable/disable, connection doctor
- Projects: repository/local path, branch, channel/user restrictions
- Skills: draft/edit/version/enable/invoke context, optional reference files
- Memory: project-scoped explicit saves and reviewable proposals
- Integrations: MCP secret-reference configuration, GitHub repositories/issues/PRs/diffs
- Settings: sanitized runtime configuration and audit log

The dashboard binds to `127.0.0.1` by default, requires the configured admin credential, uses an HttpOnly SameSite=Strict session cookie, requires a CSRF header for writes, and checks the request origin.

## Security model

- **Local mode:** trusted-local runner. Agents run with the server account's OS permissions. ACP containment is not a sandbox.
- **Server mode:** configuration refuses to start unless `RUNNER_TYPE=container`, a container image is set, and `PUBLIC_URL` is HTTPS (unless explicitly overridden). Agent containers are non-root, read-only with tmpfs, resource-limited, network-default-none, and mount only the session workspace.
- The privileged Docker launcher stays on the host side. No Docker socket is mounted into agent containers.
- Session workspaces are per-session clones or git worktrees where possible. Shared non-git paths are serialized.
- Slack channel/user allowlists and project ACLs gate prompts and approvals. Approvals are one-time, expiring, and bound to the session, requester, tool request and option set.
- Secrets are referenced by environment variable name, never returned by dashboard APIs. Logs and events redact known secret values and token patterns.
- GitHub write flows require an explicit approval. There is no merge or force-push operation.

See [docs/security.md](docs/security.md) for residual risks.

## Tests

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The tests spawn a real subprocess ACP fixture, exercise the SQLite queue and SSE endpoint, and render dashboard approval/login components. See [docs/development.md](docs/development.md).

## Documentation

- [docs/slack.md](docs/slack.md) — Slack app, tokens, routing and commands
- [docs/acp.md](docs/acp.md) — ACP behavior, capabilities, restart and compatibility
- [docs/security.md](docs/security.md) — trust model, auth, secrets and residual risk
- [docs/operations.md](docs/operations.md) — backup, restore, retention, upgrade, Docker
- [docs/development.md](docs/development.md) — tests, fixtures, adding agents and skills

ACP reference: <https://agentclientprotocol.com/protocol/v1/overview>.
