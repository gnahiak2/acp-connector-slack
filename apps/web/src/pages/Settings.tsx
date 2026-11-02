import type { AuditRecord } from "@slackboard/shared";
import { api } from "../api";
import {
  Empty,
  ErrorBanner,
  formatTime,
  Loading,
  Notice,
  PageHeader,
  StatusBadge,
} from "../components";
import { useAsync } from "../hooks";

interface SettingsShape {
  mode: "local" | "server";
  version: string;
  publicUrl?: string;
  host: string;
  port: number;
  runner: { type: string; image?: string; network: string };
  limits: Record<string, number | undefined>;
  slack: { configured: boolean; allowedChannels: string[]; allowedUsers: string[] };
  github: { configured: boolean; allowedRepos: string[] };
  auth: { adminUser: string; sessionTtlHours: number };
  acp: { protocolVersion: number };
}

export const SettingsPage = () => {
  const settings = useAsync((_signal) => api.settings(), []);
  const audit = useAsync((_signal) => api.audit(100), []);
  const value = settings.data as unknown as SettingsShape | undefined;

  return (
    <>
      <PageHeader
        title="Settings"
        description="Configuration is loaded from the server environment. Secrets are write-only and never returned by this API."
      />
      {settings.error ? <ErrorBanner message={settings.error} onRetry={settings.reload} /> : null}
      {settings.loading && !value ? <Loading label="Loading settings…" /> : null}
      {value ? (
        <>
          {value.mode === "local" ? (
            <Notice tone="warning">
              Local mode uses the trusted-local runner. Agents run with the server account's OS
              permissions; ACP containment checks are not an OS sandbox.
            </Notice>
          ) : (
            <Notice>
              Server mode requires isolated container execution and an HTTPS reverse proxy. Verify
              the runner health and container image in deployment checks.
            </Notice>
          )}
          <div className="settings-grid">
            <section className="section">
              <h2>Deployment</h2>
              <dl className="definition-list">
                <dt>Mode</dt>
                <dd>{value.mode}</dd>
                <dt>Version</dt>
                <dd>{value.version}</dd>
                <dt>Binding</dt>
                <dd>
                  {value.host}:{value.port}
                </dd>
                <dt>Public URL</dt>
                <dd>{value.publicUrl ?? "not set"}</dd>
                <dt>ACP protocol</dt>
                <dd>v{value.acp.protocolVersion}</dd>
              </dl>
            </section>
            <section className="section">
              <h2>Runner</h2>
              <dl className="definition-list">
                <dt>Type</dt>
                <dd>
                  <StatusBadge status={value.runner.type} />
                </dd>
                <dt>Image</dt>
                <dd>{value.runner.image ?? "—"}</dd>
                <dt>Network</dt>
                <dd>{value.runner.network}</dd>
              </dl>
            </section>
            <section className="section">
              <h2>Slack</h2>
              <dl className="definition-list">
                <dt>Configured</dt>
                <dd>{value.slack.configured ? "yes (Socket Mode)" : "no"}</dd>
                <dt>Allowed channels</dt>
                <dd>{value.slack.allowedChannels.join(", ") || "none (deny all)"}</dd>
                <dt>Allowed users</dt>
                <dd>{value.slack.allowedUsers.join(", ") || "none (deny all)"}</dd>
              </dl>
            </section>
            <section className="section">
              <h2>GitHub</h2>
              <dl className="definition-list">
                <dt>Configured</dt>
                <dd>{value.github.configured ? "yes (GitHub App)" : "no"}</dd>
                <dt>Allowed repositories</dt>
                <dd>{value.github.allowedRepos.join(", ") || "none"}</dd>
              </dl>
            </section>
            <section className="section">
              <h2>Limits</h2>
              <dl className="definition-list">
                {Object.entries(value.limits).map(([key, limit]) => (
                  <div key={key} className="definition-row">
                    <dt>{key}</dt>
                    <dd>{limit ?? "—"}</dd>
                  </div>
                ))}
              </dl>
            </section>
            <section className="section">
              <h2>Dashboard authentication</h2>
              <dl className="definition-list">
                <dt>Admin user</dt>
                <dd>{value.auth.adminUser}</dd>
                <dt>Session lifetime</dt>
                <dd>{value.auth.sessionTtlHours} hours</dd>
                <dt>Cookie</dt>
                <dd>HttpOnly, SameSite=Strict, CSRF header required for writes</dd>
              </dl>
            </section>
          </div>
        </>
      ) : null}

      <section className="section" aria-labelledby="audit-heading">
        <div className="section-head">
          <h2 id="audit-heading">Audit log</h2>
          <span className="muted small">Most recent 100 entries</span>
        </div>
        {audit.error ? <ErrorBanner message={audit.error} onRetry={audit.reload} /> : null}
        {audit.loading && !audit.data ? <Loading label="Loading audit log…" /> : null}
        {audit.data?.items.length === 0 ? <Empty title="No audit entries yet" /> : null}
        {audit.data && audit.data.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">Actor</th>
                  <th scope="col">Action</th>
                  <th scope="col">Target</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {audit.data.items.map((entry: AuditRecord) => (
                  <tr key={entry.id}>
                    <td className="nowrap">{formatTime(entry.createdAt)}</td>
                    <td>{entry.actor}</td>
                    <td>{entry.action}</td>
                    <td>
                      {entry.targetType}
                      {entry.targetId ? (
                        <div className="small muted">
                          <code>{entry.targetId}</code>
                        </div>
                      ) : null}
                    </td>
                    <td className="small">
                      <code>{JSON.stringify(entry.detail)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>
    </>
  );
};
