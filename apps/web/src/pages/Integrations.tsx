import { useEffect, useState } from "react";
import type {
  GithubIssueView,
  GithubPullRequestView,
  McpServerRecord,
} from "@slackboard/shared";
import { api, type McpInput } from "../api";
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  Loading,
  Modal,
  Notice,
  PageHeader,
  StatusBadge,
} from "../components";
import { useAsync } from "../hooks";

const emptyMcp = (): McpInput => ({
  name: "",
  transport: "stdio",
  command: "",
  args: [],
  envRefs: [],
  url: "",
  headerRefs: [],
  enabled: true,
});

const parseHeaders = (value: string): Array<{ name: string; envVar: string }> =>
  value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const index = line.indexOf("=");
      if (index <= 0) return { name: line, envVar: "" };
      return { name: line.slice(0, index).trim(), envVar: line.slice(index + 1).trim() };
    });

export const IntegrationsPage = () => {
  const mcp = useAsync((_signal) => api.mcp(), []);
  const github = useAsync((_signal) => api.github(), []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<McpServerRecord | undefined>(undefined);
  const [form, setForm] = useState<McpInput>(emptyMcp());
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const repositories = useAsync(
    (_signal) => (github.data?.configured ? api.githubRepositories() : Promise.resolve({ items: [] })),
    [github.data?.configured],
  );
  const [repo, setRepo] = useState("");
  const [prNumber, setPrNumber] = useState<number | undefined>(undefined);
  useEffect(() => {
    if (!repo && repositories.data?.items[0]) setRepo(repositories.data.items[0].fullName);
  }, [repositories.data, repo]);

  const issues = useAsync(
    (_signal) => (repo ? api.githubIssues(repo) : Promise.resolve({ items: [] as GithubIssueView[] })),
    [repo],
  );
  const pulls = useAsync(
    (_signal) => (repo ? api.githubPulls(repo) : Promise.resolve({ items: [] as GithubPullRequestView[] })),
    [repo],
  );
  const diff = useAsync(
    (_signal) =>
      repo && prNumber
        ? api.githubDiff(repo, prNumber)
        : Promise.resolve(undefined as { diff: string } | undefined),
    [repo, prNumber],
  );

  const openCreate = (): void => {
    setEditing(undefined);
    setForm(emptyMcp());
    setArgsText("");
    setEnvText("");
    setHeadersText("");
    setError(undefined);
    setOpen(true);
  };

  const openEdit = (server: McpServerRecord): void => {
    setEditing(server);
    setForm({
      name: server.name,
      transport: server.transport,
      command: server.command ?? "",
      args: server.args,
      envRefs: server.envRefs,
      url: server.url ?? "",
      headerRefs: server.headerRefs,
      enabled: server.enabled,
    });
    setArgsText(server.args.join("\n"));
    setEnvText(server.envRefs.join(", "));
    setHeadersText(server.headerRefs.map((header) => `${header.name}=${header.envVar}`).join("\n"));
    setError(undefined);
    setOpen(true);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const payload: McpInput = {
      ...form,
      name: form.name.trim(),
      command: form.transport === "stdio" ? form.command?.trim() || undefined : undefined,
      url: form.transport === "stdio" ? undefined : form.url?.trim() || undefined,
      args: argsText
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      envRefs: envText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      headerRefs: parseHeaders(headersText).filter((header) => header.name && header.envVar),
    };
    try {
      if (editing) await api.updateMcp(editing.id, payload);
      else await api.createMcp(payload);
      setOpen(false);
      mcp.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (server: McpServerRecord): Promise<void> => {
    if (!window.confirm(`Delete MCP server ${server.name}?`)) return;
    setBusy(true);
    try {
      await api.deleteMcp(server.id);
      mcp.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Integrations"
        description="MCP servers are passed to ACP sessions only when the agent advertises the matching transport. GitHub writes require an explicit approval."
      />
      <section className="section" aria-labelledby="mcp-heading">
        <div className="section-head">
          <h2 id="mcp-heading">MCP servers</h2>
          <Button kind="primary" onClick={openCreate}>
            Add MCP server
          </Button>
        </div>
        <Notice>
          Only environment-variable names are stored. Resolved secret values are passed to the agent
          at session startup and are never returned by the dashboard API.
        </Notice>
        {error ? <ErrorBanner message={error} onRetry={() => setError(undefined)} /> : null}
        {mcp.error ? <ErrorBanner message={mcp.error} onRetry={mcp.reload} /> : null}
        {mcp.loading && !mcp.data ? <Loading label="Loading MCP servers…" /> : null}
        {mcp.data?.items.length === 0 ? (
          <Empty title="No MCP servers configured">
            The stdio transport is baseline in ACP. HTTP and SSE are passed only when the agent
            advertises support.
          </Empty>
        ) : null}
        {mcp.data && mcp.data.items.length > 0 ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Transport</th>
                  <th scope="col">Target</th>
                  <th scope="col">Secret references</th>
                  <th scope="col">State</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {mcp.data.items.map((server) => (
                  <tr key={server.id}>
                    <td>
                      <strong>{server.name}</strong>
                      <div className="small muted">
                        <code>{server.id}</code>
                      </div>
                    </td>
                    <td>
                      <StatusBadge status={server.transport} />
                    </td>
                    <td className="small">
                      {server.transport === "stdio" ? (
                        <>
                          <code>{server.command}</code>
                          <div className="muted">{server.args.join(" ") || "no args"}</div>
                        </>
                      ) : (
                        <code>{server.url}</code>
                      )}
                    </td>
                    <td className="small">
                      {[...server.envRefs, ...server.headerRefs.map((header) => `${header.name}=${header.envVar}`)].join(
                        ", ",
                      ) || "—"}
                    </td>
                    <td>
                      <StatusBadge status={server.enabled ? "enabled" : "disabled"} />
                    </td>
                    <td>
                      <div className="button-row">
                        <Button kind="quiet" onClick={() => openEdit(server)}>
                          Edit
                        </Button>
                        <Button kind="quiet" onClick={() => void remove(server)} disabled={busy}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </section>

      <section className="section" aria-labelledby="github-heading">
        <h2 id="github-heading">GitHub</h2>
        {github.error ? <ErrorBanner message={github.error} onRetry={github.reload} /> : null}
        {github.loading && !github.data ? <Loading label="Checking GitHub integration…" /> : null}
        {github.data && !github.data.configured ? (
          <Empty title="GitHub App is not configured">
            Set GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH, GITHUB_INSTALLATION_ID and
            GITHUB_ALLOWED_REPOS on the server. Tokens are minted per installation and scoped to
            read-only cloning unless an approved workflow asks for more.
          </Empty>
        ) : null}
        {github.data?.configured ? (
          <>
            <p className="small muted">
              Allowed repositories: {github.data.allowedRepos.join(", ") || "none"} · installation{" "}
              {github.data.installationId}
            </p>
            {repositories.error ? (
              <ErrorBanner message={repositories.error} onRetry={repositories.reload} />
            ) : null}
            {repositories.data?.items.length === 0 ? (
              <Empty title="No repositories available">
                Check the installation and GITHUB_ALLOWED_REPOS.
              </Empty>
            ) : (
              <Field label="Repository">
                <select value={repo} onChange={(event) => setRepo(event.target.value)}>
                  {repositories.data?.items.map((repository) => (
                    <option key={repository.fullName} value={repository.fullName}>
                      {repository.fullName}
                      {repository.private ? " (private)" : ""}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <div className="two-column">
              <div>
                <h3>Open issues</h3>
                {issues.loading ? <Loading label="Loading issues…" /> : null}
                {issues.error ? <ErrorBanner message={issues.error} /> : null}
                {issues.data?.items.length === 0 ? <Empty title="No open issues" /> : null}
                <ul className="plain-list">
                  {issues.data?.items.map((issue) => (
                    <li key={issue.number}>
                      <a href={issue.htmlUrl} target="_blank" rel="noreferrer">
                        #{issue.number} {issue.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>Open pull requests</h3>
                {pulls.loading ? <Loading label="Loading pull requests…" /> : null}
                {pulls.error ? <ErrorBanner message={pulls.error} /> : null}
                {pulls.data?.items.length === 0 ? <Empty title="No open pull requests" /> : null}
                <ul className="plain-list">
                  {pulls.data?.items.map((pull) => (
                    <li key={pull.number}>
                      <button type="button" className="link-button" onClick={() => setPrNumber(pull.number)}>
                        #{pull.number} {pull.title}
                      </button>
                      <span className="muted small"> {pull.draft ? "draft" : ""}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            <p className="small muted">
              Draft pull requests are requested from a session, then created only after a dashboard or
              Slack approval. This integration has no merge or force-push operation.
            </p>
          </>
        ) : null}
      </section>

      <Modal open={open} title={editing ? `Edit ${editing.name}` : "Add MCP server"} onClose={() => setOpen(false)}>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="form-grid">
            <Field label="Name" required>
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            </Field>
            <Field label="Transport" required>
              <select
                value={form.transport}
                onChange={(event) =>
                  setForm({ ...form, transport: event.target.value as McpInput["transport"] })
                }
              >
                <option value="stdio">stdio</option>
                <option value="http">http</option>
                <option value="sse">sse (deprecated)</option>
              </select>
            </Field>
          </div>
          {form.transport === "stdio" ? (
            <>
              <Field label="Absolute command path" required>
                <input
                  value={form.command ?? ""}
                  onChange={(event) => setForm({ ...form, command: event.target.value })}
                  required
                />
              </Field>
              <Field label="Arguments" hint="One argument per line.">
                <textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={3} />
              </Field>
            </>
          ) : (
            <Field label="HTTPS URL" required>
              <input
                type="url"
                value={form.url ?? ""}
                onChange={(event) => setForm({ ...form, url: event.target.value })}
                required
              />
            </Field>
          )}
          <Field label="Environment references" hint="Comma-separated names passed to a stdio server. Values are not stored.">
            <input value={envText} onChange={(event) => setEnvText(event.target.value)} />
          </Field>
          {form.transport !== "stdio" ? (
            <Field label="Header references" hint="One per line, Header-Name=ENV_VAR. Values are resolved at session startup.">
              <textarea value={headersText} onChange={(event) => setHeadersText(event.target.value)} rows={3} />
            </Field>
          ) : null}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
            />
            Enabled
          </label>
          {error ? <ErrorBanner message={error} /> : null}
          <div className="dialog-actions">
            <Button kind="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" disabled={busy || !form.name}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create server"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(prNumber)} title={`Pull request #${prNumber ?? ""} diff`} onClose={() => setPrNumber(undefined)}>
        {diff.loading ? <Loading label="Loading diff…" /> : null}
        {diff.error ? <ErrorBanner message={diff.error} /> : null}
        {diff.data ? <pre className="preview diff">{diff.data.diff}</pre> : null}
      </Modal>
    </>
  );
};
