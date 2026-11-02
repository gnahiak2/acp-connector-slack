import { useState } from "react";
import type { SkillRecord } from "@slackboard/shared";
import { api, type SkillInput } from "../api";
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

interface ReferenceRow {
  path: string;
  content: string;
}

const emptySkill = (): SkillInput => ({
  name: "",
  description: "",
  version: "1.0.0",
  content: "",
  references: [],
});

export const SkillsPage = () => {
  const skills = useAsync((_signal) => api.skills(), []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<SkillRecord | undefined>(undefined);
  const [form, setForm] = useState<SkillInput>(emptySkill());
  const [references, setReferences] = useState<ReferenceRow[]>([]);
  const [enableNow, setEnableNow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [versions, setVersions] = useState<{
    skill: SkillRecord;
    versions: Array<{ version: string; createdAt: string; createdBy: string }>;
  }>();

  const openCreate = (): void => {
    setEditing(undefined);
    setForm(emptySkill());
    setReferences([]);
    setEnableNow(false);
    setError(undefined);
    setOpen(true);
  };

  const openEdit = (skill: SkillRecord): void => {
    setEditing(skill);
    setForm({
      name: skill.name,
      description: skill.description,
      version: skill.version,
      content: skill.content,
      references: skill.references,
    });
    setReferences(skill.references.map((reference) => ({ ...reference })));
    setEnableNow(false);
    setError(undefined);
    setOpen(true);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const payload: SkillInput = {
      ...form,
      references: references.filter((reference) => reference.path.trim()),
    };
    try {
      if (editing) {
        await api.updateSkill(editing.id, payload);
      } else {
        const created = await api.createSkill(payload);
        if (enableNow) await api.enableSkill(created.skill.id);
      }
      setOpen(false);
      skills.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (skill: SkillRecord): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      if (skill.status === "enabled") await api.disableSkill(skill.id);
      else await api.enableSkill(skill.id);
      skills.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const showVersions = async (skill: SkillRecord): Promise<void> => {
    setError(undefined);
    try {
      setVersions(await api.skill(skill.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  return (
    <>
      <PageHeader
        title="Skills"
        description="Portable SKILL.md instructions with optional text references. Drafts remain reviewable until explicitly enabled."
        actions={
          <Button kind="primary" onClick={openCreate}>
            New skill
          </Button>
        }
      />
      <Notice>
        Bundled and custom skills are injected as labelled context only. Bundled scripts are never
        executed automatically, and ACP does not guarantee native skill support in an agent.
      </Notice>
      {error ? <ErrorBanner message={error} onRetry={() => setError(undefined)} /> : null}
      {skills.error ? <ErrorBanner message={skills.error} onRetry={skills.reload} /> : null}
      {skills.loading && !skills.data ? <Loading label="Loading skills…" /> : null}
      {skills.data?.items.length === 0 ? (
        <Empty title="No skills available">
          Add a skill, or place a valid SKILL.md directory under the configured skills root.
        </Empty>
      ) : null}
      <ul className="card-list">
        {skills.data?.items.map((skill) => (
          <li key={skill.id} className="card">
            <div className="card-main">
              <div className="card-title">
                <strong>{skill.name}</strong>
                <span className="muted small">v{skill.version}</span>
                <StatusBadge status={skill.status} />
                <span className="badge badge-neutral">{skill.source}</span>
              </div>
              <p>{skill.description}</p>
              <p className="small muted">
                Updated {formatTime(skill.updatedAt)} · {skill.references.length} reference file
                {skill.references.length === 1 ? "" : "s"} · slug <code>{skill.slug}</code>
              </p>
            </div>
            <div className="button-row">
              <Button kind="quiet" onClick={() => void showVersions(skill)}>
                Versions
              </Button>
              {skill.source === "custom" ? (
                <Button kind="quiet" onClick={() => openEdit(skill)} disabled={busy}>
                  Edit
                </Button>
              ) : null}
              <Button kind="quiet" onClick={() => void toggle(skill)} disabled={busy}>
                {skill.status === "enabled" ? "Disable" : "Enable"}
              </Button>
            </div>
          </li>
        ))}
      </ul>

      <Modal open={open} title={editing ? `Edit ${editing.name}` : "New skill"} onClose={() => setOpen(false)}>
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="form-grid">
            <Field label="Name" hint="Lowercase letters, digits and dashes." required>
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                pattern="[a-z0-9][a-z0-9-]{0,63}"
                disabled={Boolean(editing)}
              />
            </Field>
            <Field label="Version" required>
              <input
                value={form.version ?? ""}
                onChange={(event) => setForm({ ...form, version: event.target.value })}
                required
              />
            </Field>
          </div>
          <Field label="Description" required>
            <input
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
              required
              maxLength={1024}
            />
          </Field>
          <Field label="Instructions" hint="Markdown body injected as reference context. This is not a system prompt." required>
            <textarea
              value={form.content}
              onChange={(event) => setForm({ ...form, content: event.target.value })}
              rows={12}
              required
            />
          </Field>
          <fieldset className="fieldset">
            <legend>Reference files</legend>
            <p className="small muted">Relative text paths only. They are read-only context and are never executed.</p>
            {references.map((reference, index) => (
              <div key={index} className="reference-row">
                <Field label={`Path ${index + 1}`}>
                  <input
                    value={reference.path}
                    onChange={(event) => {
                      const next = [...references];
                      next[index] = { ...reference, path: event.target.value };
                      setReferences(next);
                    }}
                    placeholder="references/checklist.md"
                  />
                </Field>
                <Field label="Content">
                  <textarea
                    value={reference.content}
                    onChange={(event) => {
                      const next = [...references];
                      next[index] = { ...reference, content: event.target.value };
                      setReferences(next);
                    }}
                    rows={4}
                  />
                </Field>
                <Button
                  kind="quiet"
                  onClick={() => setReferences(references.filter((_item, itemIndex) => itemIndex !== index))}
                >
                  Remove
                </Button>
              </div>
            ))}
            <Button kind="quiet" onClick={() => setReferences([...references, { path: "", content: "" }])}>
              Add reference
            </Button>
          </fieldset>
          {!editing ? (
            <label className="checkbox">
              <input type="checkbox" checked={enableNow} onChange={(event) => setEnableNow(event.target.checked)} />
              Enable immediately (otherwise saved as a draft)
            </label>
          ) : null}
          {error ? <ErrorBanner message={error} /> : null}
          <div className="dialog-actions">
            <Button kind="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" disabled={busy || !form.name || !form.content}>
              {busy ? "Saving…" : editing ? "Save new version" : "Create skill"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(versions)} title="Skill versions" onClose={() => setVersions(undefined)}>
        {versions ? (
          <>
            <p>
              <strong>{versions.skill.name}</strong> · current v{versions.skill.version}
            </p>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Created</th>
                    <th scope="col">By</th>
                  </tr>
                </thead>
                <tbody>
                  {versions.versions.map((version) => (
                    <tr key={version.version}>
                      <td>{version.version}</td>
                      <td>{formatTime(version.createdAt)}</td>
                      <td>{version.createdBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </Modal>
    </>
  );
};
