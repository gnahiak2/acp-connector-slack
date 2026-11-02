import { useState } from "react";
import type { ApprovalOption, ApprovalRecord, PendingApprovalView } from "@slackboard/shared";
import { api } from "./api";
import { AppLink, Button, Empty, ErrorBanner, formatTime, StatusBadge } from "./components";

const optionTone = (option: ApprovalOption): "primary" | "danger" | "secondary" =>
  option.kind.startsWith("allow") ? "primary" : option.kind.startsWith("reject") ? "danger" : "secondary";

const ApprovalCard = ({
  approval,
  onResolved,
  showSession = false,
}: {
  approval: ApprovalRecord | PendingApprovalView;
  onResolved: () => void;
  showSession?: boolean;
}) => {
  const [busy, setBusy] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [result, setResult] = useState<string | undefined>(undefined);
  const pending = approval.status === "pending";
  const sessionTitle = "sessionTitle" in approval ? approval.sessionTitle : undefined;

  const resolve = async (option: ApprovalOption): Promise<void> => {
    setBusy(option.optionId);
    setError(undefined);
    try {
      const response = await api.resolveApproval(approval.id, option.optionId);
      const url = response.action?.pullRequestUrl;
      setResult(
        typeof url === "string" ? `Draft pull request created: ${url}` : "Decision recorded.",
      );
      onResolved();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <article className="approval-card" aria-labelledby={`approval-${approval.id}`}>
      <div className="approval-head">
        <div>
          <h3 id={`approval-${approval.id}`}>{approval.title}</h3>
          <p className="muted small">
            {showSession && sessionTitle ? (
              <>
                {sessionTitle} ·{" "}
                <AppLink href={`/sessions/${approval.sessionId}`}>open session</AppLink> ·{" "}
              </>
            ) : null}
            Expires {formatTime(approval.expiresAt)}
          </p>
        </div>
        <StatusBadge status={pending ? "awaiting approval" : approval.status} />
      </div>
      {approval.toolCallId ? (
        <p className="small">
          Tool call: <code>{approval.toolCallId}</code>
        </p>
      ) : null}
      {typeof approval.details.contentPreview === "string" && approval.details.contentPreview ? (
        <pre className="preview">{approval.details.contentPreview}</pre>
      ) : null}
      {typeof approval.details.repository === "string" ? (
        <p className="small">
          Repository <code>{approval.details.repository}</code>
          {typeof approval.details.head === "string" && typeof approval.details.base === "string" ? (
            <>
              {" "}· branches <code>{approval.details.head}</code> → <code>{approval.details.base}</code>
            </>
          ) : null}
        </p>
      ) : null}
      {pending ? (
        <div className="approval-actions" role="group" aria-label="Approval options">
          {approval.options.map((option) => (
            <Button
              key={option.optionId}
              kind={optionTone(option)}
              onClick={() => void resolve(option)}
              disabled={busy !== undefined}
              title={`${option.name} (${option.kind})`}
            >
              {busy === option.optionId ? "Applying…" : option.name}
            </Button>
          ))}
        </div>
      ) : null}
      {error ? <ErrorBanner message={error} /> : null}
      {result ? <p className="small success-text">{result}</p> : null}
    </article>
  );
};

export const ApprovalPanel = ({
  approvals,
  onResolved,
  showSession = false,
  title = "Pending approvals",
}: {
  approvals: Array<ApprovalRecord | PendingApprovalView>;
  onResolved: () => void;
  showSession?: boolean;
  title?: string;
}) => (
  <section className="section" aria-labelledby="approvals-heading">
    <div className="section-head">
      <h2 id="approvals-heading">{title}</h2>
      <span className="muted small">
        {approvals.length === 0 ? "None" : `${approvals.length} waiting`}
      </span>
    </div>
    {approvals.length === 0 ? (
      <Empty title="No approvals waiting">
        Tool actions that need authorisation will appear here, with the exact options reported by the
        agent.
      </Empty>
    ) : (
      <div className="approval-list">
        {approvals.map((approval) => (
          <ApprovalCard
            key={approval.id}
            approval={approval}
            onResolved={onResolved}
            showSession={showSession}
          />
        ))}
      </div>
    )}
  </section>
);
