import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { existsSync, statSync } from "node:fs";
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

const execFileAsync = promisify(execFile);
const CONTAINER_WORKSPACE = "/workspace";
const CONTAINER_HOME = "/home/agent";

const writeEnvFile = async (env: Record<string, string>): Promise<{ dir: string; file: string }> => {
  const dir = await mkdtemp(join(tmpdir(), "slackboard-env-"));
  const lines: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value.includes("\n") || value.includes("\r")) {
      throw new RunnerError(`Environment value for ${key} contains a newline`);
    }
    lines.push(`${key}=${value}`);
  }
  const file = join(dir, "env");
  await writeFile(file, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { dir, file };
};

const containerUser = (): string => {
  const uid = typeof process.getuid === "function" ? process.getuid() : 65532;
  const gid = typeof process.getgid === "function" ? process.getgid() : 65532;
  if (uid === 0) return "65532:65532";
  return `${uid}:${gid}`;
};

export interface ContainerRunnerOptions {
  image: string;
  imageAllowlist: string[];
  network: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

const assertWorkspace = (workspace: string): void => {
  if (!isAbsolute(workspace)) throw new RunnerError("Workspace path must be absolute");
  if (workspace.includes(":")) throw new RunnerError("Workspace path cannot contain a colon");
  if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
    throw new RunnerError(`Workspace does not exist: ${workspace}`);
  }
};

const within = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export class DockerRunner implements Runner {
  readonly type = "container" as const;
  private readonly workspace = CONTAINER_WORKSPACE;

  constructor(private readonly options: ContainerRunnerOptions) {
    if (!options.image) throw new RunnerError("Container image is required");
    if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(options.image)) {
      throw new RunnerError("Container image reference contains unsupported characters");
    }
    if (
      options.imageAllowlist.length > 0 &&
      !options.imageAllowlist.includes(options.image)
    ) {
      throw new RunnerError(`Container image ${options.image} is not in the allowlist`);
    }
  }

  validate(profile: AgentProfile): void {
    if (profile.runner !== "container") {
      throw new RunnerError(`Agent ${profile.id} requests the trusted-local runner`);
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    try {
      const { stdout } = await execFileAsync("docker", ["version", "--format", "{{.Server.Version}}"], {
        timeout: 5_000,
      });
      return { ok: true, detail: `Docker ${stdout.trim()} (image ${this.options.image})` };
    } catch (error) {
      return {
        ok: false,
        detail: `Docker is unavailable: ${(error as Error).message}`,
      };
    }
  }

  async start(options: SpawnAgentOptions): Promise<RunnerHandle> {
    this.validate(options.profile);
    assertWorkspace(options.workspaceHostPath);
    const hostWorkspace = resolve(options.workspaceHostPath);
    const containerName = this.containerName(options.sessionId);
    const containerEnv = { ...options.env };
    delete containerEnv.PATH;
    const envFile = await writeEnvFile({
      ...containerEnv,
      HOME: CONTAINER_HOME,
      TMPDIR: "/tmp",
    });
    const args = [
      "run",
      "--rm",
      "--interactive",
      "--name",
      containerName,
      "--network",
      this.options.network,
      "--memory",
      `${this.options.memoryMb}m`,
      "--cpus",
      String(this.options.cpus),
      "--pids-limit",
      String(this.options.pidsLimit),
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=256m",
      "--tmpfs",
      `${CONTAINER_HOME}:rw,nosuid,nodev,size=64m`,
      "--user",
      containerUser(),
      "--volume",
      `${hostWorkspace}:${CONTAINER_WORKSPACE}:rw`,
      "--workdir",
      CONTAINER_WORKSPACE,
      "--env-file",
      envFile.file,
      this.options.image,
      options.profile.executable,
      ...options.profile.args,
    ];

    const child = spawn("docker", args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => options.onStderr?.(chunk));
    child.once("exit", () => {
      void rm(envFile.dir, { recursive: true, force: true });
    });

    const mapAgentPathToHost = (agentPath: string): string => {
      if (!agentPath.startsWith("/")) throw new RunnerError("Agent path must be absolute");
      const normalized = posix.normalize(agentPath);
      if (normalized === CONTAINER_WORKSPACE) return hostWorkspace;
      if (!normalized.startsWith(`${CONTAINER_WORKSPACE}/`)) {
        throw new PathOutsideWorkspaceError(agentPath);
      }
      const rest = normalized.slice(CONTAINER_WORKSPACE.length + 1);
      const hostPath = resolve(hostWorkspace, rest);
      if (!within(hostWorkspace, hostPath)) throw new PathOutsideWorkspaceError(agentPath);
      return hostPath;
    };

    const mapHostPathToAgent = (hostPath: string): string => {
      const absolute = resolve(hostPath);
      if (!within(hostWorkspace, absolute)) throw new PathOutsideWorkspaceError(hostPath);
      const rest = relative(hostWorkspace, absolute).split(sep).join("/");
      return rest ? `${CONTAINER_WORKSPACE}/${rest}` : CONTAINER_WORKSPACE;
    };

    const terminal = (request: TerminalRequest): TerminalProcess => {
      const agentCwd = mapHostPathToAgent(request.cwdHostPath);
      if (request.env && Object.values(request.env).some((value) => /[\r\n]/.test(value))) {
        throw new RunnerError("Terminal environment contains a newline");
      }
      const envPairs = Object.entries(request.env).filter(([key]) =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(key),
      );
      const execArgs = [
        "exec",
        "--interactive",
        "--workdir",
        agentCwd,
        ...envPairs.flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        containerName,
        request.command,
        ...request.args,
      ];
      const execChild = spawn("docker", execArgs, {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      return {
        pid: execChild.pid,
        stdout: execChild.stdout,
        stderr: execChild.stderr,
        kill: () => {
          execChild.kill("SIGTERM");
        },
        exited: new Promise((resolveExit) => {
          execChild.once("error", (error) => resolveExit({ error: error.message }));
          execChild.once("exit", (code, signal) =>
            resolveExit({ exitCode: code ?? undefined, signal: signal ?? undefined }),
          );
        }),
      };
    };

    return {
      runner: "container",
      child,
      containerName,
      mapAgentPathToHost,
      mapHostPathToAgent,
      terminal,
      dispose: async (graceMs) => {
        await this.stop(child, containerName, graceMs);
        await rm(envFile.dir, { recursive: true, force: true }).catch(() => undefined);
      },
    };
  }

  private containerName(sessionId: string): string {
    const safe = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 40);
    return `slackboard-${safe}-${Date.now().toString(36)}`;
  }

  private async stop(
    child: ReturnType<typeof spawn>,
    containerName: string,
    graceMs: number,
  ): Promise<void> {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((resolveExit) => {
        const timer = setTimeout(resolveExit, graceMs);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          resolveExit();
        });
      });
    }
    try {
      await execFileAsync("docker", ["rm", "--force", containerName], { timeout: 15_000 });
    } catch {
      // Container may already be removed by --rm.
    }
  }
}

export const containerWorkspacePath = (): string => CONTAINER_WORKSPACE;
export const containerDisplayName = (path: string): string => basename(path);
