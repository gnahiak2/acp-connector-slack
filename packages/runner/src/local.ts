import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentProfile } from "@slackboard/shared";
import {
  PathOutsideWorkspaceError,
  RunnerError,
  type Runner,
  type RunnerHandle,
  type SpawnAgentOptions,
  type TerminalProcess,
  type TerminalRequest,
} from "./types.js";

const assertWorkspace = (workspace: string): void => {
  if (!isAbsolute(workspace)) throw new RunnerError("Workspace path must be absolute");
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new RunnerError(`Workspace does not exist: ${workspace}`);
  }
};

export const isWithin = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export class LocalRunner implements Runner {
  readonly type = "local" as const;

  validate(profile: AgentProfile): void {
    if (profile.runner !== "local") {
      throw new RunnerError(`Agent ${profile.id} requests the container runner`);
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return {
      ok: true,
      detail: "Trusted-local execution: agents run with the server process's OS permissions",
    };
  }

  async start(options: SpawnAgentOptions): Promise<RunnerHandle> {
    this.validate(options.profile);
    assertWorkspace(options.workspaceHostPath);
    const child = spawn(options.profile.executable, options.profile.args, {
      cwd: options.workspaceHostPath,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));
    const workspace = resolve(options.workspaceHostPath);

    const terminal = (request: TerminalRequest): TerminalProcess => {
      const cwd = resolve(request.cwdHostPath);
      if (!isWithin(workspace, cwd)) throw new PathOutsideWorkspaceError(request.cwdHostPath);
      const child = spawn(request.command, request.args, {
        cwd,
        env: { ...options.env, ...request.env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      return {
        pid: child.pid,
        stdout: child.stdout,
        stderr: child.stderr,
        kill: () => {
          this.killTree(child);
        },
        exited: new Promise((resolveExit) => {
          child.once("error", (error) => resolveExit({ error: error.message }));
          child.once("exit", (code, signal) =>
            resolveExit({ exitCode: code ?? undefined, signal: signal ?? undefined }),
          );
        }),
      };
    };

    return {
      runner: "local",
      child,
      mapAgentPathToHost: (agentPath) => {
        const absolute = resolve(agentPath);
        if (!isWithin(workspace, absolute)) throw new PathOutsideWorkspaceError(agentPath);
        return absolute;
      },
      mapHostPathToAgent: (hostPath) => {
        const absolute = resolve(hostPath);
        if (!isWithin(workspace, absolute)) throw new PathOutsideWorkspaceError(hostPath);
        return join(workspace, relative(workspace, absolute));
      },
      terminal,
      dispose: async (graceMs) => {
        await this.stopChild(child, graceMs);
      },
    };
  }

  private killTree(child: ChildProcess): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
    const timer = setTimeout(() => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // Process already exited.
      }
    }, 3_000);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }

  private async stopChild(child: ChildProcess, graceMs: number): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return;
    this.killTree(child);
    await new Promise<void>((resolveExit) => {
      const timer = setTimeout(resolveExit, graceMs);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolveExit();
      });
    });
  }
}
