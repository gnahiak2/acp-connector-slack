import { useEffect, useState } from "react";
import type { MemoryRecord, ProjectRecord } from "@slackboard/shared";
import { api } from "../api";
import {
  Button,
  Empty,
  ErrorBanner,
  Field,
  formatTime,
  Loading,
  Modal,
  Notice,
  PageHeader,
  StatusBadge,
} from "../components";
import { useAsync } from "../hooks";

export const MemoryPage = () => {
  const projects = useAsync((_signal) => api.projects(), []);
  const [projectId, setProjectId] = useState("");
  const [status, setStatus] = useState("");
  const [content, setContent] = useState("");
  const [proposal, setProposal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [editing, setEditing] = useState<MemoryRecord | undefined>(undefined);
  const [editContent, setEditContent] = useState("");

  const activeProjects: ProjectRecord[] = (projects.data?.items ?? []).filter(
    (project) => !project.archivedAt,
  );
  useEffect(() => {
    if (!projectId && activeProjects[0]) setProjectId(activeProjects[0].id);
  }, [activeProjects, projectId]);

  const memories = useAsync(
    (_signal) =>
      projectId
        ? api.memory(projectId, status || undefined)
        : Promise.resolve({ items: [] as MemoryRecord[] }),
    [projectId, status],
  );

  const create = async (): Promise<void> => {
    if (!content.trim() || !projectId) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.createMemory(projectId, {
        content,
        provenance: "dashboard:explicit",
        proposal,
      });
      setContent("");
      setProposal(false);
      memories.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async (): Promise<void> => {
    if (!editing) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.updateMemory(editing.id, editContent);
      setEditing(undefined);
      memories.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const approve = async (memory: MemoryRecord): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await api.approveMemory(memory.id);
      memories.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (memory: MemoryRecord): Promise<void> => {
    if (!window.confirm("Delete this memory entry? It will no longer be injected into prompts.")) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.deleteMemory(memory.id);
      memories.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Memory"
        description="Curated project memory with provenance. Nothing is shared across projects or written without an explicit save or reviewed proposal."
      />
      {projects.error ? <ErrorBanner message={projects.error} onRetry={projects.reload} /> : null}
      {activeProjects.length === 0 ? (
        <Empty title="No active projects">Create a project before adding memory.</Empty>
      ) : (
        <>
          <section className="section" aria-labelledby="memory-add">
            <h2 id="memory-add">Add memory</h2>
            <form
              className="form"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <div className="form-grid">
                <Field label="Project" required>
                  <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                    {activeProjects.map((project) => (
                      <option key={project.id} value={project.id}>
                        {project.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Show" hint="Only active memory is injected into prompts.">
                  <select value={status} onChange={(event) => setStatus(event.target.value)}>
                    <option value="">All statuses</option>
                    <option value="active">Active</option>
                    <option value="proposed">Proposed</option>
                    <option value="deleted">Deleted</option>
                  </select>
                </Field>
              </div>
              <Field label="Content" hint="Facts, conventions and decisions worth carrying into future sessions." required>
                <textarea value={content} onChange={(event) => setContent(event.target.value)} rows={4} />
              </Field>
              <label className="checkbox">
                <input type="checkbox" checked={proposal} onChange={(event) => setProposal(event.target.checked)} />
                Save as a proposal requiring review (not injected until approved)
              </label>
              {error ? <ErrorBanner message={error} /> : null}
              <Button kind="primary" type="submit" disabled={busy || !content.trim() || !projectId}>
                {busy ? "Saving…" : proposal ? "Submit proposal" : "Save memory"}
              </Button>
            </form>
          </section>

          <section className="section" aria-labelledby="memory-list">
            <div className="section-head">
              <h2 id="memory-list">Entries</h2>
              <span className="muted small">
                {memories.data ? `${memories.data.items.length} entries` : ""}
              </span>
            </div>
            <Notice>
              Memory is treated as untrusted reference content. It cannot override approvals, access
              rules, or operator policy.
            </Notice>
            {memories.error ? <ErrorBanner message={memories.error} onRetry={memories.reload} /> : null}
            {memories.loading && !memories.data ? <Loading label="Loading memory…" /> : null}
            {memories.data?.items.length === 0 ? (
              <Empty title="No memory entries">Saved and proposed entries appear here.</Empty>
            ) : null}
            <ul className="card-list">
              {memories.data?.items.map((memory) => (
                <li key={memory.id} className="card">
                  <div className="card-main">
                    <div className="card-title">
                      <StatusBadge status={memory.status} />
                      <span className="muted small">
                        {memory.provenance} · updated {formatTime(memory.updatedAt)}
                      </span>
                    </div>
                    <p className="memory-content">{memory.content}</p>
                    <p className="small muted">
                      <code>{memory.id}</code>
                    </p>
                  </div>
                  <div className="button-row">
                    {memory.status === "proposed" ? (
                      <Button kind="primary" onClick={() => void approve(memory)} disabled={busy}>
                        Approve
                      </Button>
                    ) : null}
                    {memory.status !== "deleted" ? (
                      <Button
                        kind="quiet"
                        onClick={() => {
                          setEditing(memory);
                          setEditContent(memory.content);
                        }}
                        disabled={busy}
                      >
                        Edit
                      </Button>
                    ) : null}
                    {memory.status !== "deleted" ? (
                      <Button kind="quiet" onClick={() => void remove(memory)} disabled={busy}>
                        Delete
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <Modal open={Boolean(editing)} title="Edit memory" onClose={() => setEditing(undefined)}>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void saveEdit();
          }}
        >
          <Field label="Content" required>
            <textarea value={editContent} onChange={(event) => setEditContent(event.target.value)} rows={8} />
          </Field>
          <div className="dialog-actions">
            <Button kind="quiet" onClick={() => setEditing(undefined)}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" disabled={busy || !editContent.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
};
