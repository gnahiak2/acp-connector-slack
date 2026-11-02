import type { AgentCapabilitiesView, ApprovalOption, IsoDate, SessionStatus } from "./types.js";

export interface ToolLocationView {
  path: string;
  line?: number;
}

export interface PlanEntryView {
  content: string;
  priority: "high" | "medium" | "low";
  status: "pending" | "in_progress" | "completed";
}

export interface AgentCommandView {
  name: string;
  description: string;
  hint?: string;
}

export interface AgentModeView {
  id: string;
  name: string;
  description?: string;
}

export interface EventPayloadMap {
  "session.created": {
    title: string;
    agentId: string;
    projectId: string;
    origin: "slack" | "dashboard";
  };
  "session.status": {
    status: SessionStatus;
    previousStatus: SessionStatus;
  };
  "session.notice": {
    level: "info" | "warning" | "error";
    message: string;
  };
  "session.error": {
    message: string;
  };
  "session.context": {
    skills: Array<{ id: string; name: string; version: string }>;
    memoryCount: number;
  };
  "job.queued": {
    promptPreview: string;
    requestedBy: string;
  };
  "job.started": {
    requestedBy: string;
  };
  "job.finished": {
    status: "completed" | "cancelled" | "failed" | "interrupted";
    stopReason?: string;
    error?: string;
  };
  "agent.message.delta": {
    text: string;
    messageId?: string;
  };
  "agent.message.completed": {
    text: string;
    messageId?: string;
  };
  "agent.tool_call": {
    toolCallId: string;
    title: string;
    kind?: string;
    status?: string;
    locations?: ToolLocationView[];
  };
  "agent.tool_update": {
    toolCallId: string;
    title?: string;
    status?: string;
    contentPreview?: string;
  };
  "agent.plan": {
    entries: PlanEntryView[];
  };
  "agent.commands": {
    commands: AgentCommandView[];
  };
  "agent.mode": {
    currentModeId: string;
    modes: AgentModeView[];
  };
  "agent.capabilities": {
    protocolVersion: number;
    agentInfo?: { name: string; title?: string; version: string };
    capabilities: AgentCapabilitiesView;
    authMethods: Array<{ id: string; name: string; type: "agent" | "terminal" }>;
  };
  "agent.auth_required": {
    methods: Array<{ id: string; name: string; type: "agent" | "terminal"; description?: string }>;
    message: string;
  };
  "agent.disconnected": {
    reason: string;
  };
  "approval.requested": {
    approvalId: string;
    title: string;
    toolCallId?: string;
    options: ApprovalOption[];
    expiresAt: IsoDate;
  };
  "approval.resolved": {
    approvalId: string;
    outcome: "selected" | "cancelled";
    optionId?: string;
    resolvedBy?: string;
    resolution?: string;
  };
  "approval.expired": {
    approvalId: string;
  };
  "workspace.ready": {
    path: string;
  };
  "github.approval.requested": {
    approvalId: string;
    repository: string;
    head: string;
    base: string;
    title: string;
  };
  "github.approval.completed": {
    approvalId: string;
    pullRequestUrl?: string;
    number?: number;
  };
}

export type EventType = keyof EventPayloadMap;

export type PublicEvent = {
  [K in EventType]: {
    id: number;
    sessionId: string;
    jobId?: string;
    seq: number;
    type: K;
    payload: EventPayloadMap[K];
    createdAt: IsoDate;
  };
}[EventType];

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

export type NewSessionEvent = DistributiveOmit<PublicEvent, "id" | "seq" | "createdAt">;

export const EVENT_TYPES: readonly EventType[] = [
  "session.created",
  "session.status",
  "session.notice",
  "session.error",
  "session.context",
  "job.queued",
  "job.started",
  "job.finished",
  "agent.message.delta",
  "agent.message.completed",
  "agent.tool_call",
  "agent.tool_update",
  "agent.plan",
  "agent.commands",
  "agent.mode",
  "agent.capabilities",
  "agent.auth_required",
  "agent.disconnected",
  "approval.requested",
  "approval.resolved",
  "approval.expired",
  "workspace.ready",
  "github.approval.requested",
  "github.approval.completed",
];
