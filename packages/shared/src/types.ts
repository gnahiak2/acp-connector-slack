export type IsoDate = string;

export type SessionStatus =
  | "idle"
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted"
  | "stopped";

export type JobStatus =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "cancelled"
  | "failed"
  | "interrupted";

export type ApprovalStatus = "pending" | "resolved" | "expired" | "cancelled";
export type ApprovalKind = "acp_permission" | "github_push";
export type MemoryStatus = "proposed" | "active" | "deleted";
export type SkillStatus = "draft" | "enabled" | "disabled";

export interface AgentRecord {
  id: string;
  name: string;
  description?: string;
  executable: string;
  args: string[];
  env: string[];
  runner: "local" | "container";
  authentication?: string;
  enabled: boolean;
  preset: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface ProjectRecord {
  id: string;
  name: string;
  slug: string;
  localPath?: string;
  repository?: string;
  defaultBranch: string;
  allowedChannels: string[];
  allowedUsers: string[];
  archivedAt?: IsoDate;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface SessionAccessPolicy {
  userIds: string[];
  channelId?: string;
}

export interface SessionRecord {
  id: string;
  origin: "slack" | "dashboard";
  teamId?: string;
  channelId?: string;
  threadTs?: string;
  projectId: string;
  agentId: string;
  creatorId: string;
  status: SessionStatus;
  title: string;
  acpSessionId?: string;
  workspacePath: string;
  accessPolicy: SessionAccessPolicy;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  lastActivityAt: IsoDate;
  archivedAt?: IsoDate;
  lastError?: string;
}

export interface JobRecord {
  id: string;
  sessionId: string;
  prompt: string;
  requestedBy: string;
  status: JobStatus;
  dedupeKey?: string;
  createdAt: IsoDate;
  startedAt?: IsoDate;
  finishedAt?: IsoDate;
  stopReason?: string;
  error?: string;
}

export interface ApprovalOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
}

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  jobId?: string;
  kind: ApprovalKind;
  toolCallId?: string;
  title: string;
  details: Record<string, unknown>;
  options: ApprovalOption[];
  status: ApprovalStatus;
  requestedBy?: string;
  resolvedBy?: string;
  optionId?: string;
  resolution?: string;
  expiresAt: IsoDate;
  createdAt: IsoDate;
  resolvedAt?: IsoDate;
}

export interface SkillReference {
  path: string;
  content: string;
}

export interface SkillRecord {
  id: string;
  name: string;
  slug: string;
  description: string;
  version: string;
  content: string;
  references: SkillReference[];
  status: SkillStatus;
  source: "bundled" | "custom";
  createdBy: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface MemoryRecord {
  id: string;
  projectId: string;
  sessionId?: string;
  content: string;
  provenance: string;
  status: MemoryStatus;
  createdBy: string;
  createdAt: IsoDate;
  updatedAt: IsoDate;
  deletedAt?: IsoDate;
}

export interface McpServerRecord {
  id: string;
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  envRefs: string[];
  url?: string;
  headerRefs: Array<{ name: string; envVar: string }>;
  enabled: boolean;
  createdAt: IsoDate;
  updatedAt: IsoDate;
}

export interface AuditRecord {
  id: string;
  actor: string;
  action: string;
  targetType: string;
  targetId?: string;
  detail: Record<string, unknown>;
  createdAt: IsoDate;
}

export interface DashboardSessionRecord {
  id: string;
  tokenHash: string;
  csrfToken: string;
  createdAt: IsoDate;
  expiresAt: IsoDate;
  lastSeenAt: IsoDate;
}

export interface SessionSummary extends SessionRecord {
  projectName: string;
  agentName: string;
  pendingApprovalCount: number;
  lastEventAt?: IsoDate;
}

export interface DashboardUser {
  name: string;
  role: "admin";
}

export interface RuntimeHealth {
  database: { ok: boolean; path?: string };
  slack: { configured: boolean; connected: boolean; lastError?: string };
  runner: { type: "local" | "container"; ok: boolean; detail: string };
  agents: { total: number; enabled: number };
  version: string;
  mode: "local" | "server";
}

export type HealthSnapshot = RuntimeHealth;

export interface DoctorReport {
  ok: boolean;
  agentId: string;
  executable: string;
  args: string[];
  protocolVersion?: number;
  agentInfo?: { name: string; title?: string; version: string };
  capabilities?: {
    loadSession: boolean;
    prompt: { image: boolean; audio: boolean; embeddedContext: boolean };
    mcp: { http: boolean; sse: boolean };
    session: {
      list: boolean;
      delete: boolean;
      resume: boolean;
      close: boolean;
      additionalDirectories: boolean;
    };
    logout: boolean;
  };
  authMethods: Array<{ id: string; name: string; type: "agent" | "terminal"; description?: string }>;
  unsupported: string[];
  error?: string;
}

export interface AgentCapabilitiesView {
  loadSession: boolean;
  prompt: { image: boolean; audio: boolean; embeddedContext: boolean };
  mcp: { http: boolean; sse: boolean };
  session: {
    list: boolean;
    delete: boolean;
    resume: boolean;
    close: boolean;
    additionalDirectories: boolean;
  };
  logout: boolean;
}

export interface PendingApprovalView extends ApprovalRecord {
  sessionTitle: string;
  requestedByName?: string;
}

export interface GithubRepositoryView {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  htmlUrl: string;
}

export interface GithubIssueView {
  number: number;
  title: string;
  state: string;
  htmlUrl: string;
  user?: string;
}

export interface GithubPullRequestView {
  number: number;
  title: string;
  state: string;
  draft: boolean;
  htmlUrl: string;
  head: string;
  base: string;
}

export const isTerminalJobStatus = (status: JobStatus): boolean =>
  ["completed", "cancelled", "failed", "interrupted"].includes(status);

export const isTerminalSessionStatus = (status: SessionStatus): boolean =>
  ["completed", "cancelled", "failed", "interrupted", "stopped"].includes(status);
