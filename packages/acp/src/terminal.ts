import { randomBytes } from "node:crypto";
import { RequestError } from "@agentclientprotocol/sdk";
import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  KillTerminalRequest,
  ReleaseTerminalRequest,
  TerminalExitStatus,
  TerminalOutputRequest,
  TerminalOutputResponse,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
} from "@agentclientprotocol/sdk";
import type { RunnerHandle, TerminalProcess } from "@slackboard/runner";
import type { WorkspaceGuard } from "./fs-guard.js";

const BLOCKED_ENV = new Set([
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "BASH_ENV",
  "ENV",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
]);

interface TerminalEntry {
  id: string;
  process: TerminalProcess;
  buffer: string;
  truncated: boolean;
  outputByteLimit: number;
  exit?: TerminalExitStatus;
  exited: Promise<void>;
  released: boolean;
}

const appendBounded = (
  entry: Pick<TerminalEntry, "buffer" | "truncated" | "outputByteLimit">,
  chunk: string,
): void => {
  entry.buffer += chunk;
  const bytes = Buffer.byteLength(entry.buffer, "utf8");
  if (bytes <= entry.outputByteLimit) return;
  entry.truncated = true;
  const buffer = Buffer.from(entry.buffer, "utf8");
  let start = buffer.length - entry.outputByteLimit;
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  entry.buffer = buffer.subarray(start).toString("utf8");
};

export class TerminalManager {
  private readonly terminals = new Map<string, TerminalEntry>();
  private readonly maxTerminals = 8;

  constructor(
    private readonly runner: RunnerHandle,
    private readonly workspaceGuard: WorkspaceGuard,
    private readonly workspaceHostPath: string,
    private readonly maxOutputBytes: number,
    private readonly expectedSessionId: () => string | undefined,
  ) {}

  private assertSession(sessionId: string): void {
    if (sessionId !== this.expectedSessionId()) {
      throw RequestError.invalidParams({ sessionId }, "Unknown ACP session");
    }
  }

  async create(request: CreateTerminalRequest): Promise<CreateTerminalResponse> {
    this.assertSession(request.sessionId);
    if (this.terminals.size >= this.maxTerminals) {
      throw RequestError.invalidParams({}, "Terminal limit reached for this session");
    }
    if (!request.command || request.command.includes("\0")) {
      throw RequestError.invalidParams({ command: request.command }, "Invalid command");
    }
    if (request.command.length > 4096) {
      throw RequestError.invalidParams({}, "Command is too long");
    }
    const args = request.args ?? [];
    if (args.length > 128 || args.some((arg) => arg.includes("\0") || arg.length > 8192)) {
      throw RequestError.invalidParams({}, "Invalid terminal arguments");
    }
    const env: Record<string, string> = {};
    for (const variable of request.env ?? []) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable.name)) {
        throw RequestError.invalidParams({ name: variable.name }, "Invalid environment name");
      }
      if (BLOCKED_ENV.has(variable.name)) {
        throw RequestError.invalidParams(
          { name: variable.name },
          "Environment variable changes process loading or trust and is not allowed",
        );
      }
      env[variable.name] = variable.value;
    }
    const cwdHostPath = request.cwd
      ? await this.workspaceGuard.resolveDirectory(this.runner.mapAgentPathToHost(request.cwd))
      : await this.workspaceGuard.resolveDirectory(this.workspaceHostPath);
    const outputByteLimit = Math.min(
      Math.max(request.outputByteLimit ?? this.maxOutputBytes, 1024),
      this.maxOutputBytes,
    );
    const child = this.runner.terminal({
      command: request.command,
      args,
      env,
      cwdHostPath,
      outputByteLimit,
    });
    const id = `term_${randomBytes(8).toString("hex")}`;
    const entry: TerminalEntry = {
      id,
      process: child,
      buffer: "",
      truncated: false,
      outputByteLimit,
      exited: Promise.resolve(),
      released: false,
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => appendBounded(entry, chunk));
    child.stderr.on("data", (chunk: string) => appendBounded(entry, chunk));
    entry.exited = child.exited.then((result) => {
      if (result.error) {
        appendBounded(entry, `\n[slackboard] terminal error: ${result.error}\n`);
        entry.exit = {};
        return;
      }
      entry.exit = {
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
      };
    });
    this.terminals.set(id, entry);
    return { terminalId: id };
  }

  get(request: TerminalOutputRequest): TerminalOutputResponse {
    const entry = this.require(request.terminalId);
    return {
      output: entry.buffer,
      truncated: entry.truncated,
      exitStatus: entry.exit ?? null,
    };
  }

  async waitForExit(request: WaitForTerminalExitRequest): Promise<WaitForTerminalExitResponse> {
    const entry = this.require(request.terminalId);
    await entry.exited;
    return {
      exitCode: entry.exit?.exitCode ?? null,
      signal: entry.exit?.signal ?? null,
    };
  }

  kill(request: KillTerminalRequest): Record<string, never> {
    const entry = this.require(request.terminalId);
    if (!entry.exit) entry.process.kill();
    return {};
  }

  async release(request: ReleaseTerminalRequest): Promise<Record<string, never>> {
    const entry = this.require(request.terminalId);
    if (!entry.exit) {
      entry.process.kill();
      await Promise.race([entry.exited, new Promise((resolve) => setTimeout(resolve, 2_000))]);
    }
    entry.released = true;
    this.terminals.delete(request.terminalId);
    return {};
  }

  async destroyAll(): Promise<void> {
    const entries = [...this.terminals.values()];
    this.terminals.clear();
    for (const entry of entries) {
      if (!entry.exit) entry.process.kill();
    }
    await Promise.race([
      Promise.all(entries.map((entry) => entry.exited)),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }

  private require(id: string): TerminalEntry {
    const entry = this.terminals.get(id);
    if (!entry) throw new RequestError(-32002, "Terminal not found", { terminalId: id });
    return entry;
  }
}
