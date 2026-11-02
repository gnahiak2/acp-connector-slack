import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { AgentProfile } from "@slackboard/shared";
import { LocalRunner } from "@slackboard/runner";
import {
  AcpAuthRequiredError,
  NativeAcpClient,
  type AcpClientHooks,
  type PermissionDecision,
} from "../src/index.js";

const fixture = fileURLToPath(
  new URL("../../../tests/fixtures/fake-acp-agent.mjs", import.meta.url),
);

const clients: NativeAcpClient[] = [];
const dirs: string[] = [];

interface Harness {
  client: NativeAcpClient;
  workspace: string;
  updates: SessionUpdate[];
  authRequests: number;
  exits: Array<{ code: number | null; signal: string | null; stderr: string }>;
  errors: string[];
}

const startClient = async (
  env: Record<string, string> = {},
  options: {
    permission?: (request: {
      options: Array<{ optionId: string }>;
    }) => Promise<PermissionDecision>;
    workspace?: string;
  } = {},
): Promise<Harness> => {
  const workspace = options.workspace ?? (await mkdtemp(join(tmpdir(), "slackboard-acp-")));
  if (!options.workspace) dirs.push(workspace);
  const profile: AgentProfile = {
    id: "fake",
    name: "Fake agent",
    executable: process.execPath,
    args: [fixture],
    env: [],
    runner: "local",
    enabled: true,
    preset: false,
  };
  const updates: SessionUpdate[] = [];
  const exits: Harness["exits"] = [];
  const errors: string[] = [];
  let authRequests = 0;
  const hooks: AcpClientHooks = {
    onUpdate: (notification) => {
      updates.push(notification.update);
    },
    onPermission: async (request) =>
      options.permission
        ? options.permission(request)
        : { outcome: "selected", optionId: request.options[0]!.optionId },
    onAuthRequired: () => {
      authRequests += 1;
    },
    onExit: (info) => {
      exits.push({ code: info.code, signal: info.signal, stderr: info.stderr });
    },
    onError: (error) => {
      errors.push(error.message);
    },
  };
  const client = new NativeAcpClient({
    profile,
    sessionId: "test-session",
    workspaceHostPath: workspace,
    runner: new LocalRunner(),
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    limits: {
      maxMessageBytes: 1_048_576,
      maxFileBytes: 65_536,
      terminalOutputBytes: 16_384,
      startTimeoutMs: 5_000,
      promptTimeoutMs: 10_000,
    },
    hooks,
  });
  clients.push(client);
  await client.start();
  return {
    client,
    workspace,
    updates,
    get authRequests() {
      return authRequests;
    },
    exits,
    errors,
  } as Harness;
};

const textOf = (updates: SessionUpdate[]): string =>
  updates
    .filter((update) => update.sessionUpdate === "agent_message_chunk")
    .map((update) =>
      update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
        ? update.content.text
        : "",
    )
    .join("");

afterEach(async () => {
  for (const client of clients.splice(0)) await client.dispose(1_000).catch(() => undefined);
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

describe("ACP client", () => {
  it("initializes, creates a session and streams typed updates", async () => {
    const harness = await startClient();
    const session = await harness.client.ensureSession(undefined, []);
    expect(session.resumed).toBe(false);
    expect(harness.client.capabilities.loadSession).toBe(false);
    expect(harness.client.capabilities.prompt.image).toBe(true);
    expect(harness.client.capabilities.mcp.http).toBe(true);
    expect(harness.client.capabilities.session.close).toBe(true);
    const response = await harness.client.prompt("Hello");
    expect(response.stopReason).toBe("end_turn");
    const types = harness.updates.map((update) => update.sessionUpdate);
    expect(types).toContain("agent_message_chunk");
    expect(types).toContain("agent_thought_chunk");
    expect(types).toContain("tool_call");
    expect(types).toContain("tool_call_update");
    expect(types).toContain("plan");
    expect(types).toContain("available_commands_update");
    expect(types).toContain("current_mode_update");
    expect(types).toContain("notice");
    expect(textOf(harness.updates)).toContain("Hello from the fake agent.");
    expect(textOf(harness.updates)).toContain("Done.");
  });

  it("passes the exact permission options through and honours the choice", async () => {
    const harness = await startClient(
      { FAKE_PERMISSION: "1" },
      {
        permission: async (request) => ({
          outcome: "selected",
          optionId: request.options[1]!.optionId,
        }),
      },
    );
    await harness.client.ensureSession(undefined, []);
    await harness.client.prompt("Hello");
    expect(textOf(harness.updates)).toContain("choice:deny");
  });

  it("cancels a permission request that returns an unoffered option", async () => {
    const harness = await startClient(
      { FAKE_PERMISSION: "1" },
      { permission: async () => ({ outcome: "selected", optionId: "not-offered" }) },
    );
    await harness.client.ensureSession(undefined, []);
    await harness.client.prompt("Hello");
    expect(textOf(harness.updates)).toContain("choice:cancelled");
  });

  it("cancels an in-flight prompt", async () => {
    const harness = await startClient({ FAKE_HANG: "1" });
    await harness.client.ensureSession(undefined, []);
    const prompt = harness.client.prompt("Hang");
    await new Promise((resolve) => setTimeout(resolve, 150));
    await harness.client.cancelSession("test cancel");
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("reports an unexpected process exit", async () => {
    const harness = await startClient({ FAKE_CRASH: "1" });
    await harness.client.ensureSession(undefined, []);
    await expect(harness.client.prompt("Crash")).rejects.toBeTruthy();
    await vi.waitFor(() => expect(harness.exits.length).toBe(1));
    expect(harness.exits[0]?.code).toBe(3);
  });

  it("surfaces authentication-required without exposing credentials", async () => {
    const harness = await startClient({ FAKE_AUTH_REQUIRED: "1", FAKE_AUTH_METHODS: "1" });
    await expect(harness.client.ensureSession(undefined, [])).rejects.toBeInstanceOf(
      AcpAuthRequiredError,
    );
    expect(harness.authRequests).toBe(1);
    expect(harness.client.authMethods).toEqual([
      { id: "login", name: "Fake login", type: "agent", description: "Sign in out of band" },
      {
        id: "terminal-login",
        name: "Terminal login",
        type: "terminal",
        description: undefined,
      },
    ]);
  });

  it("loads a previous session only when advertised", async () => {
    const loadable = await startClient({ FAKE_LOAD: "1" });
    const loaded = await loadable.client.ensureSession("fake-session-1", []);
    expect(loaded).toEqual({ sessionId: "fake-session-1", resumed: true, replayed: true });
    expect(textOf(loadable.updates)).toContain("replayed agent");

    const plain = await startClient();
    const replacement = await plain.client.ensureSession("old-session", []);
    expect(replacement.resumed).toBe(false);
    expect(replacement.replayed).toBe(false);
    expect(replacement.sessionId).not.toBe("old-session");
  });

  it("supports terminal callbacks with output limits", async () => {
    const harness = await startClient({ FAKE_TERMINAL: "1" });
    await harness.client.ensureSession(undefined, []);
    await harness.client.prompt("Run a command");
    expect(textOf(harness.updates)).toContain("term:terminal-ok");
  });

  it("enforces filesystem containment for agent callbacks", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "slackboard-acp-fs-"));
    dirs.push(workspace);
    await writeFile(join(workspace, "inside.txt"), "inside-content");
    const inside = await startClient(
      { FAKE_FS_PATH: join(workspace, "inside.txt") },
      { workspace },
    );
    await inside.client.ensureSession(undefined, []);
    await inside.client.prompt("Read a file");
    expect(textOf(inside.updates)).toContain("fs:inside-content");

    const outsideDir = await mkdtemp(join(tmpdir(), "slackboard-acp-outside-"));
    dirs.push(outsideDir);
    await writeFile(join(outsideDir, "secret.txt"), "secret");
    const outside = await startClient({ FAKE_FS_PATH: join(outsideDir, "secret.txt") });
    await outside.client.ensureSession(undefined, []);
    await outside.client.prompt("Read a file");
    expect(textOf(outside.updates)).toContain("fs-error:");
    expect(textOf(outside.updates)).toContain("outside the session workspace");
  });

  it("survives a malformed line on stdout", async () => {
    const harness = await startClient({ FAKE_MALFORMED: "1" });
    const session = await harness.client.ensureSession(undefined, []);
    expect(session.sessionId).toBeTruthy();
    await expect(harness.client.prompt("Hello")).resolves.toMatchObject({ stopReason: "end_turn" });
  });
});
