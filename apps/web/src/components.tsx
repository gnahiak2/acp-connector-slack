import type { ReactNode } from "react";
import { useEffect, useId, useRef } from "react";

export const Button = ({
  children,
  kind = "secondary",
  type = "button",
  onClick,
  disabled,
  title,
}: {
  children: ReactNode;
  kind?: "primary" | "secondary" | "danger" | "quiet";
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) => (
  <button className={`button button-${kind}`} type={type} onClick={onClick} disabled={disabled} title={title}>
    {children}
  </button>
);

export const StatusBadge = ({ status }: { status: string }) => {
  const normalized = status.replaceAll("_", " ");
  const tone =
    status === "completed" || status === "open" || status === "enabled" || status === "active"
      ? "success"
      : status === "running" || status === "queued" || status === "connecting"
        ? "info"
        : status === "awaiting_approval" || status === "proposed" || status === "draft"
          ? "warning"
          : status === "failed" || status === "interrupted" || status === "expired"
            ? "danger"
            : "neutral";
  return (
    <span className={`badge badge-${tone}`}>
      <span className="badge-dot" aria-hidden="true" />
      {normalized}
    </span>
  );
};

export const Field = ({
  label,
  hint,
  children,
  required,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) => (
  <label className="field">
    <span className="field-label">
      {label}
      {required ? <span aria-hidden="true"> *</span> : null}
    </span>
    {children}
    {hint ? <span className="field-hint">{hint}</span> : null}
  </label>
);

export const ErrorBanner = ({ message, onRetry }: { message: string; onRetry?: () => void }) => (
  <div className="banner banner-error" role="alert">
    <span>{message}</span>
    {onRetry ? (
      <Button kind="quiet" onClick={onRetry}>
        Retry
      </Button>
    ) : null}
  </div>
);

export const Notice = ({ children, tone = "info" }: { children: ReactNode; tone?: "info" | "warning" }) => (
  <div className={`banner banner-${tone}`} role="status">
    {children}
  </div>
);

export const Loading = ({ label = "Loading…" }: { label?: string }) => (
  <div className="state" role="status">
    <span className="spinner" aria-hidden="true" />
    {label}
  </div>
);

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="state state-empty">
    <strong>{title}</strong>
    {children ? <p>{children}</p> : null}
  </div>
);

export const Modal = ({
  open,
  title,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      aria-labelledby={titleId}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
        <Button kind="quiet" onClick={onClose} title="Close dialog">
          Close
        </Button>
      </div>
      {children}
    </dialog>
  );
};

export const PageHeader = ({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) => (
  <header className="page-head">
    <div>
      <h1>{title}</h1>
      {description ? <p className="muted">{description}</p> : null}
    </div>
    {actions ? <div className="page-actions">{actions}</div> : null}
  </header>
);

export const AppLink = ({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) => (
  <a
    href={href}
    className={className}
    onClick={(event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      window.history.pushState({}, "", href);
      window.dispatchEvent(new PopStateEvent("popstate"));
    }}
  >
    {children}
  </a>
);

export const formatTime = (value: string | undefined): string => {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export const Tabs = ({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ id: string; label: string }>;
  active: string;
  onChange: (id: string) => void;
}) => {
  const move = (currentIndex: number, direction: number): void => {
    const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    const next = tabs[nextIndex];
    if (!next) return;
    onChange(next.id);
    document.getElementById(`tab-${next.id}`)?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label="Session views">
      {tabs.map((tab, index) => (
        <button
          key={tab.id}
          role="tab"
          aria-selected={active === tab.id}
          aria-controls={`panel-${tab.id}`}
          id={`tab-${tab.id}`}
          tabIndex={active === tab.id ? 0 : -1}
          className={`tab ${active === tab.id ? "tab-active" : ""}`}
          onClick={() => onChange(tab.id)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight") {
              event.preventDefault();
              move(index, 1);
            } else if (event.key === "ArrowLeft") {
              event.preventDefault();
              move(index, -1);
            } else if (event.key === "Home") {
              event.preventDefault();
              move(0, 0);
            } else if (event.key === "End") {
              event.preventDefault();
              move(tabs.length - 1, 0);
            }
          }}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
};
