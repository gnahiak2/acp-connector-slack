# Operations

## Data

Default layout:

```
data/
  slackboard.db          SQLite database (WAL mode)
  slackboard.db-wal
  slackboard.db-shm
  workspaces/<session-id>/   per-session clone or git worktree
```

SQLite stores agents, projects, sessions, jobs, ordered events, approvals, skills and versions, memory, MCP references, dashboard auth sessions, audit log and Slack dedupe entries. Secret values are not stored.

There is one backend instance per database. Redis and distributed workers are not part of this release.

## Backup

1. Stop Slackboard gracefully (`SIGTERM`) so in-flight jobs are marked interrupted and the WAL is checkpointed.
2. Copy the database files and the workspaces directory together. Keep file permissions restrictive.
3. Store the backup encrypted; it contains session transcripts and project file contents.

A live copy without stopping is possible with SQLite's backup API or `sqlite3 data/slackboard.db ".backup backup.db"`, but the workspaces must be quiesced separately.

## Restore

1. Stop the service.
2. Restore the database and workspaces to the configured `DATA_DIR`.
3. Ensure ownership matches the service account.
4. Start the service. Uncertain in-flight jobs are marked interrupted and are not replayed.
5. Verify `/healthz`, the dashboard session list and one agent doctor check.

## Retention

- Events are retained indefinitely by default. There is no automatic event compaction.
- Memory retention can delete soft-deleted entries after `MEMORY_RETENTION_DAYS` (0 disables).
- Slack dedupe entries older than seven days are purged at startup.
- Dashboard auth sessions are purged when expired.
- Audit entries are retained indefinitely and capped only at read time.
- Add an external retention job if your policy requires event/audit deletion.

## Health

- `GET /healthz` — public process/database liveness
- `GET /api/health` — authenticated deployment mode, Slack state, runner state, agent counts
- Dashboard **Settings** — sanitized configuration and audit log

No fabricated metrics are shown. A runner health check may invoke Docker and is cached briefly.

## Docker and Compose

Local trusted container:

```bash
cp .env.example .env
cp config/agents.example.json config/agents.json
docker compose up --build -d
```

Compose stores data in the named volume `slackboard_data`. Back it up with:

```bash
docker compose stop slackboard
docker run --rm -v slackboard_data:/data -v "$PWD/backup:/backup" \
  alpine tar -C /data -czf /backup/slackboard-data.tgz .
docker compose start slackboard
```

This uses the local runner inside the Slackboard container. Agent executables must exist in that image, and the container's OS permissions are the boundary. Do not use it for untrusted agents.

### Server mode

Use `SLACKBOARD_MODE=server`, `RUNNER_TYPE=container`, an approved `CONTAINER_IMAGE`, and an HTTPS `PUBLIC_URL`. The backend needs access to the Docker daemon; agent containers must not receive the socket.

When the backend itself runs in Docker and launches sibling containers, the workspace mount source must exist at the same absolute path on the host and inside the backend. Use identical bind mounts, for example:

```yaml
volumes:
  - /srv/slackboard/data:/srv/slackboard/data
  - /var/run/docker.sock:/var/run/docker.sock
environment:
  DATA_DIR: /srv/slackboard/data
  WORKSPACE_ROOT: /srv/slackboard/data/workspaces
  SLACKBOARD_MODE: server
  RUNNER_TYPE: container
  CONTAINER_IMAGE: ghcr.io/example/agent:verified
```

Add the host Docker socket group to the container (`group_add`) or run the backend on the host under a dedicated non-root service account. Keep the dashboard bound to localhost and put an HTTPS reverse proxy in front of it.

## Reverse proxy

Terminate TLS at a trusted proxy, forward to `127.0.0.1:8787`, preserve `Host`, and set `PUBLIC_URL` to the external HTTPS origin. Slackboard checks the `Origin` header against that value. Do not expose Fastify directly to the internet.

## Upgrades

1. Back up the database and workspaces.
2. Stop the service.
3. Deploy the new build, run migrations automatically at startup, and restart.
4. Check `pnpm typecheck`, `pnpm test` and `pnpm build` in the release pipeline before deployment.
5. Verify Slack Socket Mode, runner health, and one session end to end.

Database migrations are forward-only. There is no downgrade path; restore from backup to roll back.

## Process cleanup

- Cancel/stop sends `session/cancel`, cancels pending approvals and terminal processes, and disposes the ACP subprocess after a grace period.
- Local mode terminates the agent process group.
- Container mode removes the per-session container with `docker rm --force`.
- Graceful shutdown stops Slack, interrupts active turns, disposes agents and closes the database.
