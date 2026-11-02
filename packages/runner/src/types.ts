import type { AgentProfile } from "@slackboard/shared";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Readable } from "node:stream";

export interface TerminalProcess {
  pid?: number;
  stdout: Readable;
  stderr: Readable;
  kill(): void;
  exited: Promise<{ exitCode?: number; signal?: string; error?: string }>;
}

export interface TerminalRequest {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwdHostPath: string;
  outputByteLimit: number;
}

export interface RunnerHandle {
  readonly runner: "local" | "container";
  readonly child: ChildProcessWithoutNullStreams;
  readonly containerName?: string;
  mapAgentPathToHost(agentPath: string): string;
  mapHostPathToAgent(hostPath: string): string;
  terminal(request: TerminalRequest): TerminalProcess;
  dispose(graceMs: number): Promise<void>;
}

export interface SpawnAgentOptions {
  profile: AgentProfile;
  sessionId: string;
  workspaceHostPath: string;
  env: Record<string, string>;
  onStderr?(chunk: string): void;
}

export interface Runner {
  readonly type: "local" | "container";
  validate(profile: AgentProfile): void;
  start(options: SpawnAgentOptions): Promise<RunnerHandle>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerError";
  }
}

export class PathOutsideWorkspaceError extends RunnerError {
  constructor(path: string) {
    super(`Path is outside the session workspace: ${path}`);
    this.name = "PathOutsideWorkspaceError";
  }
}

export const SAFE_ENV_KEYS = ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR", "SYSTEMROOT"] as const;

export const buildEnvironment = (
  refs: readonly string[],
  source: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  for (const key of refs) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
};
