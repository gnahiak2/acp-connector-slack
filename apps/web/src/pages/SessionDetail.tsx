import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentCommandView,
  PlanEntryView,
  PublicEvent,
  SessionStatus,
  SkillRecord,
  ToolLocationView,
} from "@slackboard/shared";
import { api, type SessionDetailResponse } from "../api";
import { ApprovalPanel } from "../approvals";
import {
  AppLink,
  Button,
  Empty,
  ErrorBanner,
  Field,
  formatTime,
  Loading,
  Notice,
  PageHeader,
  StatusBadge,
  Tabs,
} from "../components";
import { useAsync, useSessionStream } from "../hooks";

type TimelineItem =
  | { kind: "message"; role: "user" | "assistant"; text: string; seq: number; key: string }
  | {
      kind: "tool";
      id: string;
      title: string;
      status?: string;
      preview?: string;
      locations?: ToolLocationView[];
      seq: number;
    }
  | { kind: "notice"; level: "info" | "warning" | "error"; text: string; seq: number }
  | { kind: "status"; text: string; seq: number }
  | { kind: "plan"; entries: PlanEntryView[]; seq: number }
  | { kind: "error"; text: string; seq: number };

const buildTimeline = (
  events: PublicEvent[],
  prompts: Map<string, string>,
): TimelineItem[] => {
  const items: TimelineItem[] = [];
  const messageIndex = new Map<string, number>();
  const toolIndex = new Map<string, number>();

  const pushMessage = (key: string, role: "user" | "assistant", text: string, seq: number): void => {
    const existing = messageIndex.get(key);
    if (existing !== undefined) {
      const item = items[existing];
      if (item?.kind === "message") item.text = text;
      return;
    }
    messageIndex.set(key, items.length);
    items.push({ kind: "message", role, text, seq, key });
  };

  for (const event of events) {
    switch (event.type) {
      case "job.queued": {
        const prompt = prompts.get(event.jobId ?? "") ?? event.payload.promptPreview;
        pushMessage(`user:${event.jobId ?? event.seq}`, "user", prompt, event.seq);
        break;
      }
      case "agent.message.delta": {
        const key = `assistant:${event.payload.messageId ?? event.jobId ?? event.seq}`;
        const index = messageIndex.get(key);
        const current = index === undefined ? "" : (items[index] as { text?: string }).text ?? "";
        pushMessage(key, "assistant", current + event.payload.text, event.seq);
        break;
      }
      case "agent.message.completed": {
        const key = `assistant:${event.payload.messageId ?? event.jobId ?? event.seq}`;
        pushMessage(key, "assistant", event.payload.text, event.seq);
        break;
      }
      case "agent.tool_call": {
        const index = toolIndex.get(event.payload.toolCallId);
        const item: TimelineItem = {
          kind: "tool",
          id: event.payload.toolCallId,
          title: event.payload.title,
          status: event.payload.status,
          locations: event.payload.locations,
          seq: event.seq,
        };
        if (index === undefined) {
          toolIndex.set(event.payload.toolCallId, items.length);
          items.push(item);
        } else {
          items[index] = { ...(items[index] as TimelineItem), ...item } as TimelineItem;
        }
        break;
      }
      case "agent.tool_update": {
        const index = toolIndex.get(event.payload.toolCallId);
        if (index === undefined) {
          toolIndex.set(event.payload.toolCallId, items.length);
          items.push({
            kind: "tool",
            id: event.payload.toolCallId,
            title: event.payload.title ?? event.payload.toolCallId,
            status: event.payload.status,
            preview: event.payload.contentPreview,
            seq: event.seq,
          });
        } else {
          const existing = items[index] as Extract<TimelineItem, { kind: "tool" }>;
          existing.title = event.payload.title ?? existing.title;
          existing.status = event.payload.status ?? existing.status;
          existing.preview = event.payload.contentPreview ?? existing.preview;
        }
        break;
      }
      case "agent.plan":
        items.push({ kind: "plan", entries: event.payload.entries, seq: event.seq });
        break;
      case "session.notice":
        items.push({
          kind: "notice",
          level: event.payload.level,
          text: event.payload.message,
          seq: event.seq,
        });
        break;
      case "session.error":
        items.push({ kind: "error", text: event.payload.message, seq: event.seq });
        break;
      case "session.status":
        items.push({
          kind: "status",
          text: `Session ${event.payload.status.replaceAll("_", " ")}`,
          seq: event.seq,
        });
        break;
      case "job.finished":
        items.push({
          kind: "status",
          text: `Turn ${event.payload.status}${event.payload.stopReason ? ` (${event.payload.stopReason})` : ""}${event.payload.error ? `: ${event.payload.error}` : ""}`,
          seq: event.seq,
        });
        break;
      case "session.context":
        if (event.payload.skills.length > 0 || event.payload.memoryCount > 0) {
          items.push({
            kind: "notice",
            level: "info",
            text: `Context injected: ${event.payload.skills.length} skill(s), ${event.payload.memoryCount} memory entr${event.payload.memoryCount === 1 ? "y" : "ies"}.`,
            seq: event.seq,
          });
        }
        break;
      case "agent.auth_required":
        items.push({ kind: "error", text: event.payload.message, seq: event.seq });
        break;
      case "agent.disconnected":
        items.push({ kind: "notice", level: "warning", text: event.payload.reason, seq: event.seq });
        break;
      case "approval.requested":
        items.push({
          kind: "status",
          text: `Approval requested: ${event.payload.title}`,
          seq: event.seq,
        });
        break;
      case "approval.resolved":
        items.push({
          kind: "status",
          text: `Approval ${event.payload.outcome === "cancelled" ? "cancelled" : "resolved"}${event.payload.optionId ? `: ${event.payload.optionId}` : ""}`,
          seq: event.seq,
        });
        break;
      case "approval.expired":
        items.push({ kind: "notice", level: "warning", text: "An approval expired.", seq: event.seq });
        break;
      case "github.approval.requested":
        items.push({
          kind: "status",
          text: `GitHub draft PR approval requested for ${event.payload.repository} (${event.payload.head} → ${event.payload.base}).`,
          seq: event.seq,
        });
        break;
      case "github.approval.completed":
        items.push({
          kind: "status",
          text: `Draft pull request ${event.payload.number ? `#${event.payload.number} ` : ""}created${event.payload.pullRequestUrl ? `: ${event.payload.pullRequestUrl}` : "."}`,
          seq: event.seq,
        });
        break;
      default:
        break;
    }
  }
  return items;
};

const Timeline = ({
  events,
  prompts,
}: {
  events: PublicEvent[];
  prompts: Map<string, string>;
}) => {
  const items = useMemo(() => buildTimeline(events, prompts), [events, prompts]);
  if (items.length === 0) {
    return <Empty title="No events yet">Send a prompt to start the session timeline.</Empty>;
  }
  return (
    <ol className="timeline">
      {items.map((item) => (
        <li key={`${item.kind}:${item.seq}`} className={`timeline-item timeline-${item.kind}`}>
          {item.kind === "message" ? (
            <div className={`message message-${item.role}`}>
              <div className="message-role">{item.role === "user" ? "User" : "Agent"}</div>
              <div className="message-text">{item.text}</div>
            </div>
          ) : null}
          {item.kind === "tool" ? (
            <details className="tool">
              <summary>
                <span>Tool: {item.title}</span>
                {item.status ? <StatusBadge status={item.status} /> : null}
              </summary>
              {item.locations && item.locations.length > 0 ? (
                <ul className="plain-list small">
                  {item.locations.map((location) => (
                    <li key={`${location.path}:${location.line ?? ""}`}>
                      <code>{location.path}</code>
                      {location.line ? `:${location.line}` : ""}
                    </li>
                  ))}
                </ul>
              ) : null}
              {item.preview ? <pre className="preview">{item.preview}</pre> : null}
            </details>
          ) : null}
          {item.kind === "notice" ? (
            <p className={`notice-line notice-${item.level}`}>
              <span className="sr-only">{item.level}: </span>
              {item.text}
            </p>
          ) : null}
          {item.kind === "error" ? <ErrorBanner message={item.text} /> : null}
          {item.kind === "status" ? <p className="status-line">{item.text}</p> : null}
          {item.kind === "plan" ? (
            <div className="plan">
              <strong>Agent plan</strong>
              <ol>
                {item.entries.map((entry) => (
                  <li key={`${entry.content}:${entry.status}`}>
                    {entry.content} <span className="muted small">({entry.status})</span>
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
        </li>
      ))}
    </ol>
  );
};

const WorkspacePanel = ({ sessionId }: { sessionId: string }) => {
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const diff = useAsync((_signal) => api.diff(sessionId), [sessionId]);
  const files = useAsync((_signal) => api.files(sessionId, path), [sessionId, path]);
  const file = useAsync(
    (_signal) => (selected ? api.file(sessionId, selected) : Promise.resolve(undefined)),
    [sessionId, selected],
  );

  return (
    <div className="workspace-grid">
      <section className="section" aria-labelledby="diff-heading">
        <div className="section-head">
          <h2 id="diff-heading">Working tree diff</h2>
          <Button kind="quiet" onClick={diff.reload}>
            Refresh
          </Button>
        </div>
        {diff.error ? <ErrorBanner message={diff.error} onRetry={diff.reload} /> : null}
        {diff.loading && !diff.data ? <Loading label="Reading diff…" /> : null}
        {diff.data && !diff.data.isGit ? (
          <Empty title="Not a git workspace">
            This project points at a directory without git metadata. The file inspector still works;
            diffs and draft pull requests require a git clone or worktree.
          </Empty>
        ) : null}
        {diff.data?.isGit ? (
          <>
            <pre className="preview diff-status">{diff.data.status || "Working tree clean."}</pre>
            <pre className="preview diff">{diff.data.diff || "No tracked changes."}</pre>
            {diff.data.truncated ? <Notice tone="warning">Diff was truncated by the server.</Notice> : null}
          </>
        ) : null}
      </section>
      <section className="section" aria-labelledby="files-heading">
        <div className="section-head">
          <h2 id="files-heading">Workspace files</h2>
          <span className="muted small">
            <code>{path || "/"}</code>
          </span>
        </div>
        {path ? (
          <Button kind="quiet" onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}>
            Up one directory
          </Button>
        ) : null}
        {files.error ? <ErrorBanner message={files.error} onRetry={files.reload} /> : null}
        {files.loading && !files.data ? <Loading label="Listing files…" /> : null}
        {files.data && files.data.entries.length === 0 ? <Empty title="Empty directory" /> : null}
        <ul className="file-list">
          {files.data?.entries.map((entry) => {
            const entryPath = entry.path;
            return (
              <li key={entryPath}>
                {entry.type === "directory" ? (
                  <button type="button" className="link-button" onClick={() => setPath(entryPath)}>
                    {entry.name}/
                  </button>
                ) : (
                  <button type="button" className="link-button" onClick={() => setSelected(entryPath)}>
                    {entry.name}
                  </button>
                )}
                {entry.type === "symlink" ? <span className="muted small"> (symlink)</span> : null}
                {entry.size !== undefined ? (
                  <span className="muted small"> {entry.size.toLocaleString()} B</span>
                ) : null}
              </li>
            );
          })}
        </ul>
        {selected ? (
          <div className="file-preview">
            <div className="section-head">
              <h3>
                <code>{selected}</code>
              </h3>
              <Button kind="quiet" onClick={() => setSelected(undefined)}>
                Close
              </Button>
            </div>
            {file.loading ? <Loading label="Reading file…" /> : null}
            {file.error ? <ErrorBanner message={file.error} /> : null}
            {file.data?.binary ? (
              <Empty title="Binary file">Preview is not available for binary content.</Empty>
            ) : null}
            {file.data && !file.data.binary ? <pre className="preview">{file.data.content}</pre> : null}
          </div>
        ) : null}
      </section>
    </div>
  );
};

const SkillsPanel = ({
  session,
  attached,
  onChanged,
}: {
  session: string;
  attached: SkillRecord[];
  onChanged: () => void;
}) => {
  const skills = useAsync((_signal) => api.skills(), []);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const attachedIds = new Set(attached.map((skill) => skill.id));
  const act = async (skill: SkillRecord, attach: boolean): Promise<void> => {
    setBusy(skill.id);
    setError(undefined);
    try {
      if (attach) await api.attachSkill(session, skill.id);
      else await api.detachSkill(session, skill.id);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <section className="section" aria-labelledby="skills-heading">
      <div className="section-head">
        <h2 id="skills-heading">Skills for this session</h2>
        <span className="muted small">{attached.length} attached</span>
      </div>
      <p className="muted small">
        Only enabled skills can be attached. Instructions and references are injected as labelled
        context on the next prompt; scripts are never executed automatically.
      </p>
      {error ? <ErrorBanner message={error} /> : null}
      {skills.error ? <ErrorBanner message={skills.error} onRetry={skills.reload} /> : null}
      {skills.loading && !skills.data ? <Loading label="Loading skills…" /> : null}
      {skills.data?.items.length === 0 ? (
        <Empty title="No skills available">
          Create a custom skill in the Skills page, or add a bundled one.
        </Empty>
      ) : null}
      <ul className="card-list">
        {skills.data?.items.map((skill) => {
          const isAttached = attachedIds.has(skill.id);
          return (
            <li key={skill.id} className="card">
              <div>
                <strong>{skill.name}</strong> <span className="muted small">v{skill.version}</span>
                <div className="small muted">{skill.description}</div>
                <StatusBadge status={skill.status} />
              </div>
              <Button
                kind={isAttached ? "secondary" : "primary"}
                disabled={skill.status !== "enabled" || busy !== undefined}
                onClick={() => void act(skill, !isAttached)}
              >
                {busy === skill.id ? "Working…" : isAttached ? "Detach" : "Attach"}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};

const GithubPanel = ({
  detail,
  onRequested,
}: {
  detail: SessionDetailResponse;
  onRequested: () => void;
}) => {
  const repository = detail.project?.repository ?? "";
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState(detail.project?.defaultBranch ?? "main");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [success, setSuccess] = useState<string | undefined>(undefined);

  if (!repository) {
    return (
      <Empty title="No GitHub repository on this project">
        Add an owner/name repository to the project, configure the GitHub App, then request a draft
        pull request. Push and PR creation require an explicit approval.
      </Empty>
    );
  }
  return (
    <section className="section" aria-labelledby="github-heading">
      <h2 id="github-heading">Request a draft pull request</h2>
      <p className="muted small">
        The server collects changed files from this session workspace, then waits for an approval
        before creating a branch, commit and draft pull request. Merging and force-pushing are not
        implemented.
      </p>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          setSuccess(undefined);
          api
            .requestPullRequest(detail.session.id, { title, body, base })
            .then(() => {
              setSuccess(
                "Approval requested. Resolve it in the pending approvals panel before anything is pushed.",
              );
              onRequested();
            })
            .catch((caught: unknown) =>
              setError(caught instanceof Error ? caught.message : String(caught)),
            )
            .finally(() => setBusy(false));
        }}
      >
        <p>
          Repository: <code>{repository}</code>
        </p>
        <Field label="Title" required>
          <input value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
        </Field>
        <Field label="Description">
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={20000} />
        </Field>
        <Field label="Base branch" required>
          <input value={base} onChange={(event) => setBase(event.target.value)} required />
        </Field>
        {error ? <ErrorBanner message={error} /> : null}
        {success ? <Notice>{success}</Notice> : null}
        <Button kind="primary" type="submit" disabled={busy || !title}>
          {busy ? "Requesting approval…" : "Request approval"}
        </Button>
      </form>
    </section>
  );
};

export const SessionDetailPage = ({ sessionId }: { sessionId: string }) => {
  const detail = useAsync((_signal) => api.session(sessionId), [sessionId]);
  const initialEvents = useAsync((_signal) => api.events(sessionId, 0, 300), [sessionId]);
  const [events, setEvents] = useState<PublicEvent[]>([]);
  const [streamReady, setStreamReady] = useState(false);
  const [liveStatus, setLiveStatus] = useState<SessionStatus | undefined>(undefined);
  const [tab, setTab] = useState("timeline");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [actionError, setActionError] = useState<string | undefined>(undefined);
  const reloadTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!initialEvents.data) return;
    setEvents(initialEvents.data.events);
    setStreamReady(true);
  }, [initialEvents.data]);

  useEffect(() => {
    setLiveStatus(detail.data?.session.status);
  }, [detail.data?.session.status]);

  const scheduleReload = useCallback(() => {
    if (reloadTimer.current) return;
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = undefined;
      detail.reload();
    }, 350);
  }, [detail]);

  const onEvent = useCallback(
    (event: PublicEvent) => {
      setEvents((current) => {
        if (current.some((item) => item.seq === event.seq)) return current;
        const next = [...current, event];
        next.sort((a, b) => a.seq - b.seq);
        return next.length > 2_000 ? next.slice(-2_000) : next;
      });
      if (event.type === "session.status") setLiveStatus(event.payload.status);
      if (
        event.type.startsWith("approval.") ||
        event.type === "job.finished" ||
        event.type === "github.approval.requested" ||
        event.type === "github.approval.completed"
      ) {
        scheduleReload();
      }
    },
    [scheduleReload],
  );

  const reset = useCallback(() => {
    setStreamReady(false);
    initialEvents.reload();
  }, [initialEvents]);

  const streamStatus = useSessionStream(
    streamReady ? sessionId : undefined,
    initialEvents.data?.maxSeq ?? 0,
    onEvent,
    reset,
  );

  useEffect(() => () => {
    if (reloadTimer.current) window.clearTimeout(reloadTimer.current);
  }, []);

  const prompts = useMemo(() => {
    const map = new Map<string, string>();
    for (const job of detail.data?.jobs ?? []) map.set(job.id, job.prompt);
    return map;
  }, [detail.data?.jobs]);

  const agentCommands = useMemo(() => {
    let commands: AgentCommandView[] = [];
    for (const event of events) {
      if (event.type === "agent.commands") commands = event.payload.commands;
    }
    return commands;
  }, [events]);

  if (detail.error) {
    return (
      <>
        <PageHeader title="Session" />
        <ErrorBanner message={detail.error} onRetry={detail.reload} />
        <p>
          <AppLink href="/">Back to sessions</AppLink>
        </p>
      </>
    );
  }
  if (!detail.data) return <Loading label="Loading session…" />;
  const { session, project, agent, approvals } = detail.data;
  const status = liveStatus ?? session.status;

  const act = async (kind: "cancel" | "stop"): Promise<void> => {
    setBusy(kind);
    setActionError(undefined);
    try {
      if (kind === "cancel") await api.cancel(session.id);
      else await api.stop(session.id);
      detail.reload();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <>
      <PageHeader
        title={session.title}
        description={`${project?.name ?? session.projectId} · ${agent?.name ?? session.agentId} · ${session.origin}`}
        actions={
          <div className="button-row">
            <StatusBadge status={status} />
            <Button kind="secondary" disabled={busy !== undefined} onClick={() => void act("cancel")}>
              {busy === "cancel" ? "Cancelling…" : "Cancel turn"}
            </Button>
            <Button kind="danger" disabled={busy !== undefined} onClick={() => void act("stop")}>
              {busy === "stop" ? "Stopping…" : "Stop agent"}
            </Button>
          </div>
        }
      />
      <p className="small muted">
        <AppLink href="/">Sessions</AppLink> / <code>{session.id}</code> · updated{" "}
        {formatTime(session.lastActivityAt)} · live stream:{" "}
        <span className={`stream-state stream-${streamStatus}`}>
          {streamStatus === "open"
            ? "connected"
            : streamStatus === "reconnecting"
              ? "reconnecting"
              : streamStatus === "connecting"
                ? "connecting"
                : streamStatus}
        </span>
      </p>
      {streamStatus === "reconnecting" ? (
        <Notice tone="warning">Live updates are reconnecting. History remains available.</Notice>
      ) : null}
      {actionError ? <ErrorBanner message={actionError} /> : null}
      {session.lastError ? <Notice tone="warning">{session.lastError}</Notice> : null}

      <ApprovalPanel
        approvals={approvals}
        onResolved={() => {
          detail.reload();
          initialEvents.reload();
        }}
        title="Approvals for this session"
      />

      <section className="section" aria-labelledby="prompt-heading">
        <h2 id="prompt-heading">Send a prompt</h2>
        <form
          className="prompt-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!prompt.trim()) return;
            setBusy("prompt");
            setActionError(undefined);
            api
              .prompt(session.id, prompt)
              .then(() => {
                setPrompt("");
                scheduleReload();
              })
              .catch((caught: unknown) =>
                setActionError(caught instanceof Error ? caught.message : String(caught)),
              )
              .finally(() => setBusy(undefined));
          }}
        >
          <label className="sr-only" htmlFor="prompt-text">
            Prompt
          </label>
          <textarea
            id="prompt-text"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={3}
            placeholder="Describe the task for the agent…"
          />
          <Button kind="primary" type="submit" disabled={busy !== undefined || !prompt.trim()}>
            {busy === "prompt" ? "Queued…" : "Send prompt"}
          </Button>
        </form>
      </section>

      {agentCommands.length > 0 ? (
        <section className="section" aria-labelledby="agent-commands-heading">
          <h2 id="agent-commands-heading">Agent commands</h2>
          <p className="muted small">
            Advertised by the selected ACP agent through <code>available_commands_update</code>. These
            are separate from Slackboard's <code>/slackboard</code> commands and are sent to the agent
            as prompt text.
          </p>
          <ul className="plain-list">
            {agentCommands.map((item) => (
              <li key={item.name}>
                <code>{item.name}</code> — {item.description}
                {item.hint ? <span className="muted small"> ({item.hint})</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Tabs
        tabs={[
          { id: "timeline", label: "Timeline" },
          { id: "workspace", label: "Workspace" },
          { id: "skills", label: "Skills" },
          { id: "github", label: "GitHub" },
        ]}
        active={tab}
        onChange={setTab}
      />
      <div
        role="tabpanel"
        id={`panel-${tab}`}
        aria-labelledby={`tab-${tab}`}
        className="tab-panel"
      >
        {tab === "timeline" ? (
          <>
            {initialEvents.error ? (
              <ErrorBanner message={initialEvents.error} onRetry={initialEvents.reload} />
            ) : null}
            <Timeline events={events} prompts={prompts} />
          </>
        ) : null}
        {tab === "workspace" ? <WorkspacePanel sessionId={session.id} /> : null}
        {tab === "skills" ? (
          <SkillsPanel
            session={session.id}
            attached={detail.data.skills}
            onChanged={detail.reload}
          />
        ) : null}
        {tab === "github" ? (
          <GithubPanel detail={detail.data} onRequested={detail.reload} />
        ) : null}
      </div>
    </>
  );
};
