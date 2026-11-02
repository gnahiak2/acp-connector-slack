import type {
  AgentRecord,
  ApprovalRecord,
  AuditRecord,
  DashboardUser,
  GithubIssueView,
  GithubPullRequestView,
  GithubRepositoryView,
  HealthSnapshot,
  McpServerRecord,
  MemoryRecord,
  PendingApprovalView,
  ProjectRecord,
  PublicEvent,
  SessionSummary,
  SkillRecord,
} from "@slackboard/shared";

export interface HealthSnapshotResponse {
  ok: boolean;
  version: string;
  mode: "local" | "server";
  database: { ok: boolean; path?: string };
  slack: { configured: boolean; connected: boolean; lastError?: string };
  runner: { type: "local" | "container"; ok: boolean; detail: string };
  agents: { total: number; enabled: number };
}

export type { HealthSnapshot };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

let csrfToken = "";

export const setCsrfToken = (token: string): void => {
  csrfToken = token;
};

export const getCsrfToken = (): string => csrfToken;

const request = async <T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal; skipAuthEvent?: boolean } = {},
): Promise<T> => {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (csrfToken && method !== "GET") headers["x-slackboard-csrf"] = csrfToken;
  const response = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const contentType = response.headers.get("content-type") ?? "";
  const payload = contentType.includes("application/json") ? await response.json() : undefined;
  if (!response.ok) {
    if (response.status === 401 && !options.skipAuthEvent) {
      window.dispatchEvent(new Event("slackboard:unauthorized"));
    }
    throw new ApiError(
      response.status,
      (payload as { error?: string } | undefined)?.error ?? `Request failed (${response.status})`,
    );
  }
  return payload as T;
};

export interface SessionDetailResponse {
  session: SessionSummary;
  project?: ProjectRecord;
  agent?: AgentRecord;
  jobs: Array<{
    id: string;
    prompt: string;
    status: string;
    requestedBy: string;
    createdAt: string;
    startedAt?: string;
    finishedAt?: string;
    stopReason?: string;
    error?: string;
  }>;
  approvals: ApprovalRecord[];
  skills: SkillRecord[];
  memory: MemoryRecord[];
}

export interface AgentInput {
  id?: string;
  name: string;
  description?: string;
  executable: string;
  args: string[];
  env: string[];
  runner: "local" | "container";
  authentication?: string;
  enabled: boolean;
}

export interface ProjectInput {
  name: string;
  slug: string;
  localPath?: string;
  repository?: string;
  defaultBranch: string;
  allowedChannels: string[];
  allowedUsers: string[];
  archived?: boolean;
}

export interface SkillInput {
  name: string;
  description: string;
  version?: string;
  content: string;
  references?: Array<{ path: string; content: string }>;
}

export interface McpInput {
  name: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args: string[];
  envRefs: string[];
  url?: string;
  headerRefs: Array<{ name: string; envVar: string }>;
  enabled: boolean;
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
};

export const api = {
  async login(username: string, password: string): Promise<{ user: DashboardUser; csrfToken: string }> {
    const result = await request<{ user: DashboardUser; csrfToken: string }>("/auth/login", {
      method: "POST",
      body: { username, password },
      skipAuthEvent: true,
    });
    setCsrfToken(result.csrfToken);
    return result;
  },
  async sessionInfo(): Promise<{ user: DashboardUser; csrfToken: string }> {
    const result = await request<{ user: DashboardUser; csrfToken: string }>("/auth/session", {
      skipAuthEvent: true,
    });
    setCsrfToken(result.csrfToken);
    return result;
  },
  async logout(): Promise<void> {
    await request("/auth/logout", { method: "POST" });
    setCsrfToken("");
  },
  health: () => request<HealthSnapshotResponse>("/health"),
  settings: () => request<Record<string, unknown>>("/settings"),
  audit: (limit = 100) => request<{ items: AuditRecord[] }>(`/audit${query({ limit })}`),

  sessions: (params: {
    status?: string;
    projectId?: string;
    agentId?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) => request<{ items: SessionSummary[] }>(`/sessions${query(params)}`),
  createSession: (body: { projectId: string; agentId: string; title?: string }) =>
    request<{ session: SessionSummary }>("/sessions", { method: "POST", body }),
  session: (id: string) => request<SessionDetailResponse>(`/sessions/${encodeURIComponent(id)}`),
  events: (id: string, after = 0, limit = 300) =>
    request<{ events: PublicEvent[]; maxSeq: number }>(
      `/sessions/${encodeURIComponent(id)}/events${query({ after, limit })}`,
    ),
  prompt: (id: string, text: string) =>
    request<{ jobId: string; duplicate: boolean }>(`/sessions/${encodeURIComponent(id)}/prompts`, {
      method: "POST",
      body: { text },
    }),
  cancel: (id: string) =>
    request<{ ok: true }>(`/sessions/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  stop: (id: string) =>
    request<{ ok: true }>(`/sessions/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  diff: (id: string) =>
    request<{ isGit: boolean; status: string; diff: string; truncated: boolean }>(
      `/sessions/${encodeURIComponent(id)}/diff`,
    ),
  files: (id: string, path = "") =>
    request<{ entries: Array<{ path: string; name: string; type: string; size?: number }> }>(
      `/sessions/${encodeURIComponent(id)}/files${query({ path })}`,
    ),
  file: (id: string, path: string) =>
    request<{ content: string; truncated: boolean; binary: boolean }>(
      `/sessions/${encodeURIComponent(id)}/file${query({ path })}`,
    ),
  attachSkill: (id: string, skillId: string) =>
    request<{ skills: SkillRecord[] }>(`/sessions/${encodeURIComponent(id)}/skills`, {
      method: "POST",
      body: { skillId },
    }),
  detachSkill: (id: string, skillId: string) =>
    request<{ skills: SkillRecord[] }>(
      `/sessions/${encodeURIComponent(id)}/skills/${encodeURIComponent(skillId)}`,
      { method: "DELETE" },
    ),
  requestPullRequest: (
    id: string,
    body: { title: string; body: string; repository?: string; base?: string; head?: string },
  ) =>
    request<{ approval: ApprovalRecord }>(
      `/sessions/${encodeURIComponent(id)}/github/pull-requests`,
      { method: "POST", body },
    ),

  approvals: () => request<{ items: PendingApprovalView[] }>("/approvals"),
  resolveApproval: (id: string, optionId: string) =>
    request<{ approval: ApprovalRecord; action?: Record<string, unknown>; error?: string }>(
      `/approvals/${encodeURIComponent(id)}/resolve`,
      { method: "POST", body: { optionId } },
    ),

  agents: () => request<{ items: AgentRecord[] }>("/agents"),
  createAgent: (body: AgentInput) =>
    request<{ agent: AgentRecord }>("/agents", { method: "POST", body }),
  updateAgent: (id: string, body: Partial<AgentInput>) =>
    request<{ agent: AgentRecord }>(`/agents/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    }),
  deleteAgent: (id: string) =>
    request<{ ok: true }>(`/agents/${encodeURIComponent(id)}`, { method: "DELETE" }),
  doctor: (id: string) =>
    request<{ report: import("@slackboard/shared").DoctorReport }>(
      `/agents/${encodeURIComponent(id)}/doctor`,
      { method: "POST" },
    ),

  projects: () => request<{ items: ProjectRecord[] }>("/projects"),
  createProject: (body: ProjectInput) =>
    request<{ project: ProjectRecord }>("/projects", { method: "POST", body }),
  updateProject: (id: string, body: Partial<ProjectInput>) =>
    request<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    }),

  skills: () => request<{ items: SkillRecord[] }>("/skills"),
  skill: (id: string) =>
    request<{ skill: SkillRecord; versions: Array<{ version: string; createdAt: string; createdBy: string }> }>(
      `/skills/${encodeURIComponent(id)}`,
    ),
  createSkill: (body: SkillInput) =>
    request<{ skill: SkillRecord }>("/skills", { method: "POST", body }),
  updateSkill: (id: string, body: Partial<SkillInput>) =>
    request<{ skill: SkillRecord }>(`/skills/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    }),
  enableSkill: (id: string) =>
    request<{ skill: SkillRecord }>(`/skills/${encodeURIComponent(id)}/enable`, { method: "POST" }),
  disableSkill: (id: string) =>
    request<{ skill: SkillRecord }>(`/skills/${encodeURIComponent(id)}/disable`, {
      method: "POST",
    }),

  memory: (projectId: string, status?: string) =>
    request<{ items: MemoryRecord[] }>(
      `/projects/${encodeURIComponent(projectId)}/memory${query({ status })}`,
    ),
  createMemory: (
    projectId: string,
    body: { content: string; provenance?: string; proposal?: boolean },
  ) =>
    request<{ memory: MemoryRecord }>(`/projects/${encodeURIComponent(projectId)}/memory`, {
      method: "POST",
      body,
    }),
  updateMemory: (id: string, content: string) =>
    request<{ memory: MemoryRecord }>(`/memory/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { content },
    }),
  approveMemory: (id: string) =>
    request<{ memory: MemoryRecord }>(`/memory/${encodeURIComponent(id)}/approve`, {
      method: "POST",
    }),
  deleteMemory: (id: string) =>
    request<{ ok: true }>(`/memory/${encodeURIComponent(id)}`, { method: "DELETE" }),

  mcp: () => request<{ items: McpServerRecord[] }>("/integrations/mcp"),
  createMcp: (body: McpInput) =>
    request<{ server: McpServerRecord }>("/integrations/mcp", { method: "POST", body }),
  updateMcp: (id: string, body: Partial<McpInput>) =>
    request<{ server: McpServerRecord }>(`/integrations/mcp/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body,
    }),
  deleteMcp: (id: string) =>
    request<{ ok: true }>(`/integrations/mcp/${encodeURIComponent(id)}`, { method: "DELETE" }),

  github: () =>
    request<{ configured: boolean; allowedRepos: string[]; installationId?: number }>(
      "/integrations/github",
    ),
  githubRepositories: () =>
    request<{ items: GithubRepositoryView[] }>("/integrations/github/repositories"),
  githubIssues: (repository: string) =>
    request<{ items: GithubIssueView[] }>(
      `/integrations/github/issues${query({ repository })}`,
    ),
  githubPulls: (repository: string) =>
    request<{ items: GithubPullRequestView[] }>(
      `/integrations/github/pulls${query({ repository })}`,
    ),
  githubDiff: (repository: string, number: number) =>
    request<{ diff: string }>(
      `/integrations/github/pulls/${number}/diff${query({ repository })}`,
    ),
};
