import { useState } from "react";
import type { AgentRecord, DoctorReport } from "@slackboard/shared";
import { api, type AgentInput } from "../api";
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

const emptyAgent = (): AgentInput => ({
  name: "",
  description: "",
  executable: "",
  args: [],
  env: [],
  runner: "local",
  authentication: "",
  enabled: true,
});

export const AgentsPage = () => {
  const agents = useAsync((_signal) => api.agents(), []);
  const [editing, setEditing] = useState<AgentRecord | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState<AgentInput>(emptyAgent());
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [doctor, setDoctor] = useState<{ agent: AgentRecord; report: DoctorReport } | undefined>();
  const [doctorBusy, setDoctorBusy] = useState<string | undefined>(undefined);

  const openCreate = (): void => {
    setEditing(undefined);
    setForm(emptyAgent());
    setArgsText("");
    setEnvText("");
    setError(undefined);
    setCreating(true);
  };

  const openEdit = (agent: AgentRecord): void => {
    setEditing(agent);
    setForm({
      id: agent.id,
      name: agent.name,
      description: agent.description ?? "",
      executable: agent.executable,
      args: agent.args,
      env: agent.env,
      runner: agent.runner,
      authentication: agent.authentication ?? "",
      enabled: agent.enabled,
    });
    setArgsText(agent.args.join("\n"));
    setEnvText(agent.env.join(", "));
    setError(undefined);
    setCreating(true);
  };

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    const payload: AgentInput = {
      ...form,
      id: form.id?.trim() || undefined,
      name: form.name.trim(),
      description: form.description?.trim() || undefined,
      executable: form.executable.trim(),
      args: argsText
        .split("\n")
        .map((value) => value.trim())
        .filter(Boolean),
      env: envText
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
      authentication: form.authentication?.trim() || undefined,
    };
    try {
      if (editing) await api.updateAgent(editing.id, payload);
      else await api.createAgent(payload);
      setCreating(false);
      agents.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (agent: AgentRecord): Promise<void> => {
    setBusy(true);
    try {
      await api.updateAgent(agent.id, { enabled: !agent.enabled });
      agents.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (agent: AgentRecord): Promise<void> => {
    if (!window.confirm(`Delete agent ${agent.name}? Existing sessions will block deletion.`)) return;
    setBusy(true);
    try {
      await api.deleteAgent(agent.id);
      agents.reload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const runDoctor = async (agent: AgentRecord): Promise<void> => {
    setDoctorBusy(agent.id);
    setError(undefined);
    try {
      const result = await api.doctor(agent.id);
      setDoctor({ agent, report: result.report });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setDoctorBusy(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title="Agents"
        description="Profiles define an executable and argument array. Slack input can select a profile but can never supply a command."
        actions={
          <Button kind="primary" onClick={openCreate}>
            Add agent
          </Button>
        }
      />
      <Notice>
        Verify the exact executable and arguments with the connection doctor before relying on a
        profile. This release ships no claimed agent presets.
      </Notice>
      {error ? <ErrorBanner message={error} onRetry={() => setError(undefined)} /> : null}
      {agents.error ? <ErrorBanner message={agents.error} onRetry={agents.reload} /> : null}
      {agents.loading && !agents.data ? <Loading label="Loading agents…" /> : null}
      {agents.data?.items.length === 0 ? (
        <Empty title="No agents configured">
          Add an ACP agent profile. The agent supplies its own model authentication.
        </Empty>
      ) : null}
      {agents.data && agents.data.items.length > 0 ? (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Runner</th>
                <th scope="col">Invocation</th>
                <th scope="col">Env refs</th>
                <th scope="col">State</th>
                <th scope="col">Updated</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {agents.data.items.map((agent) => (
                <tr key={agent.id}>
                  <td>
                    <strong>{agent.name}</strong>
                    <div className="small muted">
                      <code>{agent.id}</code>
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={agent.runner === "local" ? "local (trusted)" : "container"} />
                  </td>
                  <td>
                    <code>{agent.executable}</code>
                    <div className="small muted">{agent.args.join(" ") || "no arguments"}</div>
                  </td>
                  <td className="small">{agent.env.length > 0 ? agent.env.join(", ") : "—"}</td>
                  <td>
                    <StatusBadge status={agent.enabled ? "enabled" : "disabled"} />
                  </td>
                  <td className="nowrap">{formatTime(agent.updatedAt)}</td>
                  <td>
                    <div className="button-row">
                      <Button kind="quiet" onClick={() => void runDoctor(agent)} disabled={doctorBusy !== undefined}>
                        {doctorBusy === agent.id ? "Checking…" : "Doctor"}
                      </Button>
                      <Button kind="quiet" onClick={() => openEdit(agent)}>
                        Edit
                      </Button>
                      <Button kind="quiet" onClick={() => void toggle(agent)} disabled={busy}>
                        {agent.enabled ? "Disable" : "Enable"}
                      </Button>
                      <Button kind="quiet" onClick={() => void remove(agent)} disabled={busy}>
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

      <Modal
        open={creating}
        title={editing ? `Edit ${editing.name}` : "Add agent"}
        onClose={() => setCreating(false)}
      >
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="form-grid">
            <Field label="Agent id" hint="Lowercase letters, digits and dashes; immutable after creation." required={!editing}>
              <input
                value={form.id ?? ""}
                onChange={(event) => setForm({ ...form, id: event.target.value })}
                required={!editing}
                disabled={Boolean(editing)}
                pattern="[a-z0-9][a-z0-9-]{0,63}"
              />
            </Field>
            <Field label="Display name" required>
              <input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required />
            </Field>
          </div>
          <Field label="Description">
            <input
              value={form.description ?? ""}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Field>
          <Field label="Executable" hint="A path or PATH-resolved program. Executed without a shell." required>
            <input
              value={form.executable}
              onChange={(event) => setForm({ ...form, executable: event.target.value })}
              required
            />
          </Field>
          <Field label="Arguments" hint="One argument per line. Never type a shell command string.">
            <textarea value={argsText} onChange={(event) => setArgsText(event.target.value)} rows={4} />
          </Field>
          <Field label="Environment references" hint="Comma-separated variable names passed from the server environment. Values are never stored or displayed.">
            <input value={envText} onChange={(event) => setEnvText(event.target.value)} />
          </Field>
          <div className="form-grid">
            <Field label="Runner" required>
              <select
                value={form.runner}
                onChange={(event) => setForm({ ...form, runner: event.target.value as "local" | "container" })}
              >
                <option value="local">local (trusted)</option>
                <option value="container">container (isolated)</option>
              </select>
            </Field>
            <Field label="Enabled">
              <select
                value={form.enabled ? "yes" : "no"}
                onChange={(event) => setForm({ ...form, enabled: event.target.value === "yes" })}
              >
                <option value="yes">Yes</option>
                <option value="no">No</option>
              </select>
            </Field>
          </div>
          <Field label="Authentication instructions" hint="Operator-only notes. Browser and terminal authentication is not performed in Slack.">
            <textarea
              value={form.authentication ?? ""}
              onChange={(event) => setForm({ ...form, authentication: event.target.value })}
              rows={3}
            />
          </Field>
          {error ? <ErrorBanner message={error} /> : null}
          <div className="dialog-actions">
            <Button kind="quiet" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button kind="primary" type="submit" disabled={busy || !form.name || !form.executable}>
              {busy ? "Saving…" : editing ? "Save changes" : "Create agent"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal open={Boolean(doctor)} title="Connection doctor" onClose={() => setDoctor(undefined)}>
        {doctor ? (
          <div className="stack">
            <p>
              Agent <strong>{doctor.agent.name}</strong>: {doctor.report.ok ? "initialized" : "failed"}
            </p>
            <pre className="preview">
              {JSON.stringify(
                {
                  executable: doctor.report.executable,
                  args: doctor.report.args,
                  protocolVersion: doctor.report.protocolVersion,
                  agentInfo: doctor.report.agentInfo,
                  capabilities: doctor.report.capabilities,
                  authMethods: doctor.report.authMethods,
                  unsupported: doctor.report.unsupported,
                  error: doctor.report.error,
                },
                null,
                2,
              )}
            </pre>
            <p className="small muted">
              Authentication URLs and credentials are deliberately not shown. Complete browser or
              terminal authentication as an operator setup step.
            </p>
          </div>
        ) : null}
      </Modal>
    </>
  );
};
