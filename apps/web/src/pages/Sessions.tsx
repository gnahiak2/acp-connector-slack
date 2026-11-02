import { useEffect, useState } from "react";
import type { AgentRecord, ProjectRecord, SessionSummary } from "@slackboard/shared";
import { api } from "../api";
import { ApprovalPanel } from "../approvals";
import {
  AppLink,
  Button,
  Empty,
  ErrorBanner,
  Field,
  formatTime,
  Loading,
  Modal,
  PageHeader,
  StatusBadge,
} from "../components";
import { useAsync } from "../hooks";

export const SessionsPage = ({ onOpen }: { onOpen: (id: string) => void }) => {
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [agentId, setAgentId] = useState("");
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [modal, setModal] = useState(false);
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [newProject, setNewProject] = useState("");
  const [newAgent, setNewAgent] = useState("");
  const [title, setTitle] = useState("");

  const sessions = useAsync(
    (_signal) =>
      api.sessions({
        status: status || undefined,
        projectId: projectId || undefined,
        agentId: agentId || undefined,
        q: query || undefined,
        limit: 100,
      }),
    [status, projectId, agentId, query],
  );
  const approvals = useAsync(() => api.approvals(), []);
  const projects = useAsync(() => api.projects(), []);
  const agents = useAsync(() => api.agents(), []);

  const projectList: ProjectRecord[] = projects.data?.items ?? [];
  const agentList: AgentRecord[] = agents.data?.items ?? [];
  const activeProjects = projectList.filter((project) => !project.archivedAt);
  const activeAgents = agentList.filter((agent) => agent.enabled);

  useEffect(() => {
    if (!newProject) setNewProject(activeProjects[0]?.id ?? "");
    if (!newAgent) setNewAgent(activeAgents[0]?.id ?? "");
  }, [activeProjects, activeAgents, newProject, newAgent]);

  const create = async (): Promise<void> => {
    setCreating(true);
    setFormError(undefined);
    try {
      const result = await api.createSession({
        projectId: newProject,
        agentId: newAgent,
        title: title || undefined,
      });
      setModal(false);
      setTitle("");
      onOpen(result.session.id);
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Every agent turn runs in a persisted session with an auditable event log."
        actions={
          <Button kind="primary" onClick={() => setModal(true)} disabled={activeProjects.length === 0}>
            New session
          </Button>
        }
      />
      <ApprovalPanel
        approvals={approvals.data?.items ?? []}
        onResolved={() => {
          approvals.reload();
          sessions.reload();
        }}
        showSession
      />
      <section className="section" aria-labelledby="sessions-heading">
        <div className="section-head">
          <h2 id="sessions-heading">All sessions</h2>
          <span className="muted small">
            {sessions.data ? `${sessions.data.items.length} shown` : ""}
          </span>
        </div>
        <form
          className="filters"
          onSubmit={(event) => {
            event.preventDefault();
            setQuery(search.trim());
          }}
          role="search"
        >
          <label className="inline-field">
            <span>Status</span>
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Any</option>
              {["idle", "queued", "running", "awaiting_approval", "completed", "cancelled", "failed", "interrupted", "stopped"].map(
                (value) => (
                  <option key={value} value={value}>
                    {value.replaceAll("_", " ")}
                  </option>
                ),
              )}
            </select>
          </label>
          <label className="inline-field">
            <span>Project</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              <option value="">Any</option>
              {projectList.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-field">
            <span>Agent</span>
            <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="">Any</option>
              {agentList.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          <label className="inline-field grow">
            <span>Search</span>
            <input
              type="search"
              value={search}
              placeholder="Title, id or requester"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <Button type="submit">Apply</Button>
        </form>
        {sessions.error ? (
          <ErrorBanner message={sessions.error} onRetry={sessions.reload} />
        ) : null}
        {sessions.loading && !sessions.data ? (
          <Loading label="Loading sessions…" />
        ) : sessions.data && sessions.data.items.length === 0 ? (
          <Empty title="No sessions match these filters">
            Start one from Slack with <code>/slackboard start</code>, or create a dashboard session.
          </Empty>
        ) : sessions.data ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Status</th>
                  <th scope="col">Session</th>
                  <th scope="col">Project</th>
                  <th scope="col">Agent</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Approvals</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data.items.map((session: SessionSummary) => (
                  <tr key={session.id}>
                    <td>
                      <StatusBadge status={session.status} />
                    </td>
                    <td>
                      <AppLink href={`/sessions/${session.id}`}>
                        <strong>{session.title}</strong>
                      </AppLink>
                      <div className="small muted">
                        {session.origin} · <code>{session.id}</code>
                      </div>
                    </td>
                    <td>{session.projectName}</td>
                    <td>{session.agentName}</td>
                    <td className="nowrap">{formatTime(session.lastActivityAt)}</td>
                    <td>
                      {session.pendingApprovalCount > 0 ? (
                        <span className="badge badge-warning">{session.pendingApprovalCount} pending</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {sessions.loading && sessions.data ? (
          <p className="small muted" role="status">
            Refreshing…
          </p>
        ) : null}
      </section>

      <Modal open={modal} title="Create a session" onClose={() => setModal(false)}>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Field label="Project" required>
            <select value={newProject} onChange={(event) => setNewProject(event.target.value)} required>
              {activeProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Agent" required>
            <select value={newAgent} onChange={(event) => setNewAgent(event.target.value)} required>
              {activeAgents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name} ({agent.runner})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Title" hint="Optional; defaults to a timestamped title.">
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={200} />
          </Field>
          {activeProjects.length === 0 ? (
            <p className="muted small">Create a project before starting a session.</p>
          ) : null}
          {formError ? <ErrorBanner message={formError} /> : null}
          <div className="dialog-actions">
            <Button kind="quiet" onClick={() => setModal(false)}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" disabled={creating || !newProject || !newAgent}>
              {creating ? "Creating…" : "Create session"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
};
