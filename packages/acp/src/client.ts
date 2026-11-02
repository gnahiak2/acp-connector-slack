import { Readable, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentProfile, AgentCapabilitiesView, DoctorReport } from "@slackboard/shared";
import type { Runner, RunnerHandle } from "@slackboard/runner";
import { WorkspaceGuard } from "./fs-guard.js";
import { TerminalManager } from "./terminal.js";
import {
  AcpAuthRequiredError,
  AcpError,
  AcpProtocolError,
  AcpUnsupportedError,
  isAuthRequired,
  isRequestCancelled,
  isSessionNotFound,
  type AuthMethodSummary,
} from "./errors.js";
import { capabilityView, emptyDoctorReport, unsupportedFeatures } from "./capabilities.js";

export class AcpTimeoutError extends AcpError {
  constructor(message: string) {
    super(message);
    this.name = "AcpTimeoutError";
  }
}

export interface PermissionPrompt {
  sessionId: string;
  toolCall: acp.ToolCallUpdate;
  options: acp.PermissionOption[];
}

export type PermissionDecision =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

export interface AcpClientHooks {
  onUpdate(notification: acp.SessionNotification): void | Promise<void>;
  onPermission(request: PermissionPrompt): Promise<PermissionDecision>;
  onStderr?(chunk: string): void;
  onExit?(info: {
    code: number | null;
    signal: string | null;
    expected: boolean;
    stderr: string;
  }): void;
  onError?(error: AcpError): void;
  onCapabilities?(info: {
    protocolVersion: number;
    agentInfo?: { name: string; title?: string; version: string };
    capabilities: AgentCapabilitiesView;
    authMethods: AuthMethodSummary[];
  }): void;
  onAuthRequired?(methods: AuthMethodSummary[], message: string): void;
}

export interface AcpClientOptions {
  profile: AgentProfile;
  sessionId: string;
  workspaceHostPath: string;
  runner: Runner;
  env: Record<string, string>;
  limits: {
    maxMessageBytes: number;
    maxFileBytes: number;
    terminalOutputBytes: number;
    startTimeoutMs: number;
    promptTimeoutMs: number;
  };
  hooks: AcpClientHooks;
  clientName?: string;
  clientVersion?: string;
}

export interface EnsureSessionResult {
  sessionId: string;
  resumed: boolean;
  replayed: boolean;
}

const authMethodsOf = (response: acp.InitializeResponse | undefined): AuthMethodSummary[] =>
  (response?.authMethods ?? []).map((method) => ({
    id: method.id,
    name: method.name,
    type: "type" in method && method.type === "terminal" ? "terminal" : "agent",
    description: method.description ?? undefined,
  }));

const agentInfoOf = (
  response: acp.InitializeResponse | undefined,
): { name: string; title?: string; version: string } | undefined => {
  if (!response?.agentInfo) return undefined;
  return {
    name: response.agentInfo.name,
    title: response.agentInfo.title ?? undefined,
    version: response.agentInfo.version,
  };
};

export class NativeAcpClient {
  private runnerHandle?: RunnerHandle;
  private connection?: acp.ClientConnection;
  private context?: acp.ClientContext;
  private initResponse?: acp.InitializeResponse;
  private currentSessionId?: string;
  private guard: WorkspaceGuard;
  private terminals?: TerminalManager;
  private updateChain: Promise<void> = Promise.resolve();
  private turnAbort = new AbortController();
  private stderrBuffer = "";
  private started = false;
  private disposed = false;
  private exitNotified = false;
  private startFailure?: Error;

  constructor(private readonly options: AcpClientOptions) {
    this.guard = new WorkspaceGuard([options.workspaceHostPath], options.limits.maxFileBytes);
  }

  get sessionId(): string | undefined {
    return this.currentSessionId;
  }

  get capabilities(): AgentCapabilitiesView {
    return capabilityView(this.initResponse?.agentCapabilities);
  }

  get authMethods(): AuthMethodSummary[] {
    return authMethodsOf(this.initResponse);
  }

  get agentInfo(): { name: string; title?: string; version: string } | undefined {
    return agentInfoOf(this.initResponse);
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  get isRunning(): boolean {
    return this.started && !this.disposed && this.connection !== undefined;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.startFailure) throw this.startFailure;
    await this.guard.init();
    const handle = await this.options.runner.start({
      profile: this.options.profile,
      sessionId: this.options.sessionId,
      workspaceHostPath: this.options.workspaceHostPath,
      env: this.options.env,
      onStderr: (chunk) => this.captureStderr(chunk),
    });
    this.runnerHandle = handle;
    const child = handle.child;
    child.once("error", (error) => {
      const acpError = new AcpError(`Agent process error: ${error.message}`);
      this.startFailure = acpError;
      this.options.hooks.onError?.(acpError);
      this.connection?.close(acpError);
    });
    child.once("exit", (code, signal) => this.handleExit(child, code, signal));

    const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
    const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(writable, readable, {
      maxMessageBytes: this.options.limits.maxMessageBytes,
    });

    const app = acp
      .client({ name: this.options.clientName ?? "slackboard" })
      .onRequest(acp.methods.client.session.requestPermission, (ctx) =>
        this.handlePermission(ctx.params),
      )
      .onRequest(acp.methods.client.fs.readTextFile, (ctx) => this.handleReadFile(ctx.params))
      .onRequest(acp.methods.client.fs.writeTextFile, (ctx) => this.handleWriteFile(ctx.params))
      .onRequest(acp.methods.client.terminal.create, (ctx) =>
        this.requireTerminals().create(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.output, (ctx) =>
        this.requireTerminals().get(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.waitForExit, (ctx) =>
        this.requireTerminals().waitForExit(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.kill, (ctx) =>
        this.requireTerminals().kill(ctx.params),
      )
      .onRequest(acp.methods.client.terminal.release, (ctx) =>
        this.requireTerminals().release(ctx.params),
      )
      .onNotification(acp.methods.client.session.update, (ctx) => this.handleUpdate(ctx.params));

    this.connection = app.connect(stream);
    this.context = this.connection.agent;
    const init = await this.withTimeout(
      this.context.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
          session: { notices: {} },
        },
        clientInfo: {
          name: this.options.clientName ?? "slackboard",
          title: "Slackboard",
          version: this.options.clientVersion ?? "0.1.0",
        },
      }),
      this.options.limits.startTimeoutMs,
      "Agent did not complete initialization in time",
      () => this.connection?.close(new Error("Initialization timed out")),
    );
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
      await this.dispose(1_000);
      throw new AcpProtocolError(
        `Unsupported ACP protocol version ${init.protocolVersion}; expected ${acp.PROTOCOL_VERSION}`,
        -32600,
      );
    }
    this.initResponse = init;
    this.started = true;
    this.terminals = new TerminalManager(
      handle,
      this.guard,
      this.options.workspaceHostPath,
      this.options.limits.terminalOutputBytes,
      () => this.currentSessionId,
    );
    this.options.hooks.onCapabilities?.({
      protocolVersion: init.protocolVersion,
      agentInfo: agentInfoOf(init),
      capabilities: this.capabilities,
      authMethods: this.authMethods,
    });
  }

  async ensureSession(
    existingAcpSessionId: string | undefined,
    mcpServers: acp.McpServer[],
  ): Promise<EnsureSessionResult> {
    await this.start();
    const ctx = this.requireContext();
    const handle = this.requireHandle();
    const cwd = handle.mapHostPathToAgent(this.options.workspaceHostPath);
    const capabilities = this.capabilities;

    if (existingAcpSessionId) {
      if (capabilities.loadSession) {
        this.currentSessionId = existingAcpSessionId;
        try {
          await ctx.request(acp.methods.agent.session.load, {
            sessionId: existingAcpSessionId,
            cwd,
            mcpServers,
          });
          await this.settleUpdates();
          return { sessionId: existingAcpSessionId, resumed: true, replayed: true };
        } catch (error) {
          this.currentSessionId = undefined;
          if (isSessionNotFound(error)) {
            try {
              const response = await ctx.request(acp.methods.agent.session.new, {
                cwd,
                mcpServers,
              });
              this.currentSessionId = response.sessionId;
              return { sessionId: response.sessionId, resumed: false, replayed: false };
            } catch (createError) {
              throw this.mapAuthError(createError, "Cannot create an agent session");
            }
          }
          throw this.mapAuthError(error, "Cannot load the agent session");
        }
      }
      if (capabilities.session.resume) {
        try {
          await ctx.request(acp.methods.agent.session.resume, {
            sessionId: existingAcpSessionId,
            cwd,
            mcpServers,
          });
          this.currentSessionId = existingAcpSessionId;
          return { sessionId: existingAcpSessionId, resumed: true, replayed: false };
        } catch (error) {
          throw this.mapAuthError(error, "Cannot resume the agent session");
        }
      }
    }

    try {
      const response = await ctx.request(acp.methods.agent.session.new, {
        cwd,
        mcpServers,
      });
      this.currentSessionId = response.sessionId;
      return { sessionId: response.sessionId, resumed: false, replayed: false };
    } catch (error) {
      throw this.mapAuthError(error, "Cannot create an agent session");
    }
  }

  async prompt(text: string): Promise<acp.PromptResponse> {
    const ctx = this.requireContext();
    const sessionId = this.requireSessionId();
    this.turnAbort = new AbortController();
    const request = ctx.request(
      acp.methods.agent.session.prompt,
      {
        sessionId,
        prompt: [{ type: "text", text }],
      },
      { cancellationSignal: this.turnAbort.signal },
    );
    request.catch(() => undefined);
    try {
      const response = await this.withTimeout(
        request,
        this.options.limits.promptTimeoutMs,
        "Agent prompt timed out",
        () => {
          void this.cancelSession("Prompt timed out");
        },
      );
      await this.settleUpdates();
      return response;
    } catch (error) {
      if (isRequestCancelled(error)) return { stopReason: "cancelled" };
      throw this.mapAuthError(error, "Agent prompt failed");
    } finally {
      if (this.turnAbort.signal.aborted) {
        this.turnAbort = new AbortController();
      }
    }
  }

  async cancelSession(reason: string): Promise<void> {
    const ctx = this.context;
    const sessionId = this.currentSessionId;
    this.turnAbort.abort();
    if (ctx && sessionId) {
      await ctx
        .notify(acp.methods.agent.session.cancel, { sessionId })
        .catch((error) =>
          this.options.hooks.onError?.(new AcpError(`Cancel failed: ${String(reason)}: ${String(error)}`)),
        );
    }
    await this.terminals?.destroyAll();
  }

  async setMode(modeId: string): Promise<void> {
    const ctx = this.requireContext();
    const sessionId = this.requireSessionId();
    await ctx.request(acp.methods.agent.session.setMode, { sessionId, modeId });
  }

  async logout(): Promise<void> {
    if (!this.capabilities.logout) throw new AcpUnsupportedError("Agent does not support logout");
    await this.requireContext().request(acp.methods.agent.logout, {});
  }

  async closeSession(): Promise<void> {
    if (!this.capabilities.session.close) {
      throw new AcpUnsupportedError("Agent does not support session/close");
    }
    const sessionId = this.currentSessionId;
    if (!sessionId) return;
    await this.requireContext().request(acp.methods.agent.session.close, { sessionId });
    this.currentSessionId = undefined;
  }

  async dispose(graceMs = 5_000): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.terminals?.destroyAll().catch(() => undefined);
    try {
      this.connection?.close(new Error("Client shut down"));
    } catch {
      // Connection may already be closed.
    }
    if (this.runnerHandle) await this.runnerHandle.dispose(graceMs).catch(() => undefined);
  }

  private handleExit(
    child: ChildProcessWithoutNullStreams,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    child.stdout.removeAllListeners();
    child.stderr.removeAllListeners();
    if (this.exitNotified) return;
    this.exitNotified = true;
    const expected = this.disposed;
    const errorMessage = this.stderrBuffer.trim().split("\n").slice(-12).join("\n");
    if (!expected) {
      const error = new AcpError(
        `Agent process exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "none"})`,
      );
      this.startFailure = error;
      this.options.hooks.onError?.(error);
      this.options.hooks.onExit?.({
        code,
        signal,
        expected,
        stderr: errorMessage,
      });
    }
  }

  private handleUpdate(notification: acp.SessionNotification): Promise<void> {
    this.updateChain = this.updateChain
      .then(() => this.options.hooks.onUpdate(notification))
      .catch((error) => {
        this.options.hooks.onError?.(
          error instanceof AcpError
            ? error
            : new AcpError(`Session update handler failed: ${(error as Error).message}`),
        );
      });
    return this.updateChain;
  }

  private async settleUpdates(): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    let idle = 0;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const before = this.updateChain;
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      await this.updateChain;
      if (before !== this.updateChain) {
        idle = 0;
        continue;
      }
      idle += 1;
      if (idle >= 3) return;
    }
    await this.updateChain;
  }

  private async handlePermission(
    request: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    const sessionId = this.currentSessionId;
    if (!sessionId || request.sessionId !== sessionId) {
      return { outcome: { outcome: "cancelled" } };
    }
    if (this.turnAbort.signal.aborted) {
      return { outcome: { outcome: "cancelled" } };
    }
    const aborted = new Promise<PermissionDecision>((resolve) => {
      this.turnAbort.signal.addEventListener(
        "abort",
        () => resolve({ outcome: "cancelled" }),
        { once: true },
      );
    });
    try {
      const decision = await Promise.race([
        this.options.hooks.onPermission({
          sessionId,
          toolCall: request.toolCall,
          options: request.options,
        }),
        aborted,
      ]);
      if (decision.outcome === "cancelled") {
        return { outcome: { outcome: "cancelled" } };
      }
      if (!request.options.some((option) => option.optionId === decision.optionId)) {
        return { outcome: { outcome: "cancelled" } };
      }
      return { outcome: { outcome: "selected", optionId: decision.optionId } };
    } catch (error) {
      this.options.hooks.onError?.(
        error instanceof AcpError
          ? error
          : new AcpError(`Permission handling failed: ${(error as Error).message}`),
      );
      return { outcome: { outcome: "cancelled" } };
    }
  }

  private async handleReadFile(
    request: acp.ReadTextFileRequest,
  ): Promise<acp.ReadTextFileResponse> {
    this.assertRequestSession(request.sessionId);
    const mapped = this.mapAgentPath(request.path);
    return this.guard.readTextFile({ ...request, path: mapped });
  }

  private async handleWriteFile(
    request: acp.WriteTextFileRequest,
  ): Promise<acp.WriteTextFileResponse> {
    this.assertRequestSession(request.sessionId);
    const mapped = this.mapAgentPath(request.path);
    await this.guard.writeTextFile({ ...request, path: mapped });
    return {};
  }

  private mapAgentPath(path: string): string {
    const handle = this.requireHandle();
    try {
      return handle.mapAgentPathToHost(path);
    } catch (error) {
      throw acp.RequestError.invalidParams(
        { path },
        error instanceof Error ? error.message : "Path is outside the workspace",
      );
    }
  }

  private assertRequestSession(sessionId: string): void {
    if (sessionId !== this.currentSessionId) {
      throw acp.RequestError.invalidParams({ sessionId }, "Unknown ACP session");
    }
  }

  private requireTerminals(): TerminalManager {
    if (!this.terminals) throw acp.RequestError.internalError(undefined, "Client is not ready");
    return this.terminals;
  }

  private requireContext(): acp.ClientContext {
    if (!this.context) throw new AcpError("Agent connection is not ready");
    return this.context;
  }

  private requireHandle(): RunnerHandle {
    if (!this.runnerHandle) throw new AcpError("Agent process is not ready");
    return this.runnerHandle;
  }

  private requireSessionId(): string {
    if (!this.currentSessionId) throw new AcpError("No active ACP session");
    return this.currentSessionId;
  }

  private mapAuthError(error: unknown, prefix: string): Error {
    if (isAuthRequired(error)) {
      const methods = this.authMethods;
      const message = `${prefix}: the agent requires authentication. Complete the operator setup step, then retry.`;
      this.options.hooks.onAuthRequired?.(methods, message);
      return new AcpAuthRequiredError(message, methods);
    }
    if (error instanceof acp.RequestError) {
      return new AcpProtocolError(`${prefix}: ${error.message}`, error.code, error.data);
    }
    return error instanceof Error ? error : new AcpError(prefix);
  }

  private captureStderr(chunk: string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk}`;
    if (this.stderrBuffer.length > 65_536) {
      this.stderrBuffer = this.stderrBuffer.slice(-65_536);
    }
    this.options.hooks.onStderr?.(chunk);
  }

  private async withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
    onTimeout: () => void,
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            onTimeout();
            reject(new AcpTimeoutError(message));
          }, timeoutMs);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const doctorReportFromClient = (
  client: NativeAcpClient,
  agentId: string,
  executable: string,
  args: string[],
): DoctorReport => {
  const capabilities = client.capabilities;
  return {
    ...emptyDoctorReport(agentId, executable, args),
    ok: true,
    protocolVersion: acp.PROTOCOL_VERSION,
    agentInfo: client.agentInfo,
    capabilities,
    authMethods: client.authMethods,
    unsupported: unsupportedFeatures(capabilities),
    error: client.stderr.trim() ? client.stderr.trim().split("\n").slice(-6).join("\n") : undefined,
  };
};
