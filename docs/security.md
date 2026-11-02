# Security

## Trust model

ACP itself does not sandbox agents. Files, tool results, MCP output, skills and memory can all influence agent output. Treat all agent-authored text, paths and URIs as untrusted data. Permission requests are advisory; the client enforces its own file and terminal policy.

## Deployment modes

### Local (default)

- `SLACKBOARD_MODE=local`, `RUNNER_TYPE=local`
- Agents run as the Slackboard service account with direct OS access
- Workspace containment constrains Slackboard's filesystem callbacks, not the agent's own subprocesses
- Suitable for a trusted operator's machine or a trusted single-tenant host
- The dashboard warns about this mode and the service logs a startup warning

### Server

Configuration refuses to start unless:

- `RUNNER_TYPE=container`
- `CONTAINER_IMAGE` is set
- `PUBLIC_URL` is HTTPS unless `ALLOW_INSECURE_HTTP=true` is explicitly set

The container runner starts a non-root, per-session container with:

- approved image only (allowlist supported)
- memory, CPU and PID limits
- `--cap-drop ALL`, `no-new-privileges`, read-only root with writable tmpfs
- only the session workspace mounted
- no host home, SSH keys or Docker socket
- network default `none` (`CONTAINER_NETWORK` can be changed by the operator)

The host-side backend is the only component that talks to the Docker daemon. Never mount the Docker socket into an agent container.

## Dashboard authentication

- One configured admin credential (`ADMIN_USER` / `ADMIN_PASSWORD`).
- The password is scrypt-hashed at startup and never retained in plaintext in `AppConfig`.
- Login issues a random opaque session token stored hashed in SQLite. The cookie is HttpOnly, SameSite=Strict, path `/`, and Secure in server mode.
- Every write requires the per-session CSRF token in `x-slackboard-csrf`.
- Requests with a foreign `Origin` or `Sec-Fetch-Site: cross-site` are rejected.
- Login attempts are rate limited and audited.
- Sessions expire after `SESSION_TTL_HOURS`.
- The dashboard binds to `127.0.0.1` by default. Remote access requires HTTPS through a reverse proxy; Slackboard does not terminate TLS itself.

The static dashboard can be loaded without authentication, but every API call requires a valid session.

## Slack authorisation

- Channel and user allowlists are fail-closed; empty lists deny all Slack traffic.
- DMs are user-gated; channel ACLs apply to channels/groups.
- Project channel/user ACLs narrow access further.
- Every prompt, session read, approval and skill/memory action rechecks access.
- Approval resolution is bound to the session, requester, tool call, exact option set and expiry, and is resolved atomically once.
- Stale or duplicated approvals cannot authorise a later operation.
- Agent-authored Slack text is escaped so it cannot create mentions or links by default.

## Secrets

- Agent profiles store environment variable *names*, not values. Values are read from the server process at launch.
- MCP configuration stores environment/header reference names only.
- GitHub App private keys are read from an absolute path; installation tokens are short-lived and never returned by the API.
- Dashboard APIs never return Slack/GitHub tokens, agent environment values, MCP secret values or the admin password.
- Events and audit details are redacted against configured secret values and common token patterns.
- Pino redacts cookie, authorization and CSRF headers.
- Logs may still contain agent-provided text. Do not paste secrets into prompts, repository files or skills.

## Prompt injection and untrusted content

Skills, memory, repository files, MCP output and Slack messages are labelled as reference data. They never override access rules or approval requirements. This reduces confusion but cannot prevent a model from following malicious instructions. Keep write credentials out of ordinary agent processes and require approval for pushes/PRs.

## GitHub

- GitHub App authentication, scoped installation tokens.
- `GITHUB_ALLOWED_REPOS` gates every read and write. Empty means none.
- Clone credentials are passed through git configuration environment variables, not URLs or logs, and are scoped to the repository.
- Draft pull request creation requires an explicit Slack/dashboard approval.
- No merge and no force-push operations exist in the integration.
- Deleted files are not published by the draft-PR flow; review the generated diff.

## Residual risks

- A malicious or compromised agent binary is out of scope.
- Local mode is not a sandbox.
- Container isolation depends on Docker, host kernel and correct deployment configuration.
- A user can approve a harmful operation.
- Prompt injection can steer an allowed operation.
- Secrets deliberately placed in an agent's environment are visible to that agent.
- The backend has Docker access in container-runner deployments; protect the host and socket.
- SQLite and workspaces are only as protected as the host filesystem.

## Reporting a vulnerability

Do not open a public issue containing credentials. Remove secrets from logs and rotate affected Slack, GitHub and model-provider credentials before sharing diagnostics.
