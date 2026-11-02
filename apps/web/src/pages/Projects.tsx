import { useState } from "react";
import type { ProjectRecord } from "@slackboard/shared";
import { api, type ProjectInput } from "../api";
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
} from "../components";
import { useAsync } from "../hooks";

const emptyProject = (): ProjectInput => ({
  name: "",
  slug: "",
  localPath: "",
  repository: "",
  defaultBranch: "main",
  allowedChannels: [],
  allowedUsers: [],
});

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

export const ProjectsPage = () => {
  const projects = useAsync((_signal) => api.projects(), []);
  const [editing, setEditing] = useState<ProjectRecord | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ProjectInput>(emptyProject());
  const [channelsText, setChannelsText] = useState("");
  const [usersText, setUsersText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const openCreate = (): void => {
    setEditing(undefined);
    setForm(emptyProject());
    setChannelsText("");
    setUsersText("");
    setError(undefined);
    setOpen(true);
  };

  const openEdit = (project: ProjectRecord): void => {
    setEditing(project);
    setForm({
      name: project.name,
      slug: project.slug,
      localPath: project.localPath ?? "",
      repository: project.repository ?? "",
      defaultBranch: project.defaultBranch,
      allowedChannels: project.allowedChannels,
      allowedUsers: project.allowedUsers,
      archived: Boolean(project.archivedAt),
    });
    setChannelsText(project.allowedChannels.join(", "));
    setUsersText(project.allowedUsers.join(", "));
    setError(undefined);
    setOpen(true);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const payload: ProjectInput = {
      ...form,
      name: form.name.trim(),
      slug: form.slug.trim(),
      localPath: form.localPath?.trim() || undefined,
      repository: form.repository?.trim() || undefined,
      allowedChannels: channelsText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      allowedUsers: usersText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    };
    try {
      if (editing) await api.updateProject(editing.id, payload);
      else await api.createProject(payload);
      setOpen(false);
      projects.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const archive = async (project: ProjectRecord): Promise<void> => {
    setBusy(true);
    try {
      await api.updateProject(project.id, { archived: true });
      projects.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        title="Projects"
        description="A project supplies a repository or local directory, a default branch, and optional channel/user restrictions."
        actions={
          <Button kind="primary" onClick={openCreate}>
            Add project
          </Button>
        }
      />
      <Notice>
        Local runner agents receive the session workspace directly. In server mode, project paths are
        mounted only into isolated per-session containers.
      </Notice>
      {error ? <ErrorBanner message={error} onRetry={() => setError(undefined)} /> : null}
      {projects.error ? <ErrorBanner message={projects.error} onRetry={projects.reload} /> : null}
      {projects.loading && !projects.data ? <Loading label="Loading projects…" /> : null}
      {projects.data?.items.length === 0 ? (
        <Empty title="No projects configured">
          Add a repository or a local git checkout before starting a session.
        </Empty>
      ) : null}
      {projects.data && projects.data.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Project</th>
                <th scope="col">Source</th>
                <th scope="col">Branch</th>
                <th scope="col">Access</th>
                <th scope="col">Updated</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.items.map((project) => (
                <tr key={project.id}>
                  <td>
                    <strong>{project.name}</strong>
                    <div className="small muted">
                      <code>{project.slug}</code>
                      {project.archivedAt ? " · archived" : ""}
                    </div>
                  </td>
                  <td>
                    {project.repository ? (
                      <code>{project.repository}</code>
                    ) : (
                      <code>{project.localPath}</code>
                    )}
                  </td>
                  <td>{project.defaultBranch}</td>
                  <td className="small">
                    {project.allowedChannels.length > 0 ? (
                      <div>channels: {project.allowedChannels.join(", ")}</div>
                    ) : (
                      <div>all allowed channels</div>
                    )}
                    {project.allowedUsers.length > 0 ? (
                      <div>users: {project.allowedUsers.join(", ")}</div>
                    ) : (
                      <div>all allowed users</div>
                    )}
                  </td>
                  <td className="nowrap">{formatTime(project.updatedAt)}</td>
                  <td>
                    <div className="button-row">
                      <Button kind="quiet" onClick={() => openEdit(project)}>
                        Edit
                      </Button>
                      {!project.archivedAt ? (
                        <Button kind="quiet" onClick={() => void archive(project)} disabled={busy}>
                          Archive
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <Modal open={open} title={editing ? `Edit ${editing.name}` : "Add project"} onClose={() => setOpen(false)}>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="form-grid">
            <Field label="Name" required>
              <input
                value={form.name}
                onChange={(event) => {
                  const name = event.target.value;
                  setForm({
                    ...form,
                    name,
                    slug: editing || form.slug ? form.slug : slugify(name),
                  });
                }}
                required
              />
            </Field>
            <Field label="Slug" required>
              <input
                value={form.slug}
                onChange={(event) => setForm({ ...form, slug: event.target.value })}
                required
                pattern="[a-z0-9][a-z0-9-]{0,63}"
              />
            </Field>
          </div>
          <Field label="Repository" hint="owner/name or an https Git URL. Cloned per session.">
            <input
              value={form.repository ?? ""}
              onChange={(event) => setForm({ ...form, repository: event.target.value })}
            />
          </Field>
          <Field label="Local path" hint="Absolute path. Git checkouts become per-session worktrees; non-git paths are shared and serialized.">
            <input
              value={form.localPath ?? ""}
              onChange={(event) => setForm({ ...form, localPath: event.target.value })}
            />
          </Field>
          <Field label="Default branch" required>
            <input
              value={form.defaultBranch}
              onChange={(event) => setForm({ ...form, defaultBranch: event.target.value })}
              required
            />
          </Field>
          <Field label="Allowed channels" hint="Comma-separated Slack channel ids. Empty means no project-level channel restriction.">
            <input value={channelsText} onChange={(event) => setChannelsText(event.target.value)} />
          </Field>
          <Field label="Allowed users" hint="Comma-separated Slack user ids. Empty means no project-level user restriction.">
            <input value={usersText} onChange={(event) => setUsersText(event.target.value)} />
          </Field>
          {error ? <ErrorBanner message={error} /> : null}
          <div className="dialog-actions">
            <Button kind="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" disabled={busy || !form.name || !form.slug}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create project"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
};
