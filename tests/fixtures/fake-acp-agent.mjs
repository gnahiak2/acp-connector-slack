#!/usr/bin/env node
import readline from "node:readline";

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

let nextRequestId = 1000;
const pending = new Map();
let currentSession = "fake-session-1";
let promptId = null;
let malformedSent = false;

const request = (method, params) =>
  new Promise((resolve) => {
    const id = nextRequestId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

const notify = (method, params) => send({ jsonrpc: "2.0", method, params });

const sessionUpdate = (update) =>
  notify("session/update", { sessionId: currentSession, update });

const capabilities = () => {
  const loadSession = process.env.FAKE_LOAD === "1";
  return {
    loadSession,
    promptCapabilities: { image: true, audio: false, embeddedContext: true },
    mcpCapabilities: { http: true, sse: false },
    sessionCapabilities: {
      list: {},
      ...(loadSession ? { resume: {} } : {}),
      close: {},
      additionalDirectories: {},
    },
    auth: { logout: {} },
  };
};

const initializeResult = () => ({
  protocolVersion: 1,
  agentCapabilities: capabilities(),
  authMethods:
    process.env.FAKE_AUTH_METHODS === "1"
      ? [
          { id: "login", name: "Fake login", description: "Sign in out of band" },
          { id: "terminal-login", name: "Terminal login", type: "terminal", args: ["--login"] },
        ]
      : [],
  agentInfo: { name: "fake-acp-agent", title: "Fake ACP Agent", version: "1.2.3" },
});

const handleRequest = async (message) => {
  const respond = (result) => send({ jsonrpc: "2.0", id: message.id, result });
  const fail = (code, text, data) =>
    send({ jsonrpc: "2.0", id: message.id, error: { code, message: text, data } });

  switch (message.method) {
    case "initialize":
      respond(initializeResult());
      return;
    case "authenticate":
      respond({});
      return;
    case "logout":
      respond({});
      return;
    case "session/new":
      if (process.env.FAKE_AUTH_REQUIRED === "1") {
        fail(-32000, "Authentication required", { authMethods: ["login"] });
        return;
      }
      respond({
        sessionId: currentSession,
        modes: {
          currentModeId: "code",
          availableModes: [
            { id: "code", name: "Code" },
            { id: "ask", name: "Ask" },
          ],
        },
      });
      return;
    case "session/load": {
      if (process.env.FAKE_LOAD !== "1") {
        fail(-32601, "Method not found");
        return;
      }
      currentSession = message.params.sessionId;
      sessionUpdate({
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "replayed user" },
      });
      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "replayed agent" },
      });
      respond({});
      return;
    }
    case "session/resume":
      currentSession = message.params.sessionId;
      respond({});
      return;
    case "session/set_mode":
      sessionUpdate({ sessionUpdate: "current_mode_update", currentModeId: message.params.modeId });
      respond({});
      return;
    case "session/prompt":
      await handlePrompt(message, respond, fail);
      return;
    default:
      fail(-32601, "Method not found");
  }
};

const handlePrompt = async (message, respond, fail) => {
  if (process.env.FAKE_AUTH_REQUIRED === "1") {
    fail(-32000, "Authentication required");
    return;
  }
  if (process.env.FAKE_CRASH === "1") {
    setTimeout(() => process.exit(3), 30);
    return;
  }
  if (process.env.FAKE_HANG === "1" || process.argv.includes("--hang")) {
    promptId = message.id;
    return;
  }
  sessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "Hello from the fake agent." },
  });
  sessionUpdate({
    sessionUpdate: "agent_thought_chunk",
    content: { type: "text", text: "private reasoning must not be published" },
  });
  sessionUpdate({
    sessionUpdate: "tool_call",
    toolCallId: "tc-1",
    title: "Inspect workspace",
    kind: "read",
    status: "in_progress",
    locations: [{ path: `${process.cwd()}/README.md`, line: 1 }],
  });
  sessionUpdate({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-1",
    status: "completed",
    content: [{ type: "content", content: { type: "text", text: "tool output" } }],
  });
  sessionUpdate({
    sessionUpdate: "plan",
    entries: [
      { content: "Inspect the workspace", priority: "high", status: "completed" },
      { content: "Report findings", priority: "medium", status: "in_progress" },
    ],
  });
  sessionUpdate({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "review", description: "Review the change", input: { hint: "scope" } }],
  });
  sessionUpdate({ sessionUpdate: "current_mode_update", currentModeId: "code" });
  sessionUpdate({
    sessionUpdate: "notice",
    severity: "warning",
    title: "Fake notice",
    description: "This is a fake notice.",
  });

  if (process.env.FAKE_PERMISSION === "1") {
    const result = await request("session/request_permission", {
      sessionId: currentSession,
      toolCall: { toolCallId: "tc-1", title: "Write a file" },
      options: [
        { optionId: "allow", name: "Allow once", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    const outcome = result?.result?.outcome;
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: ` choice:${outcome?.outcome === "selected" ? outcome.optionId : "cancelled"}`,
      },
    });
  }

  if (process.env.FAKE_FS_PATH) {
    const result = await request("fs/read_text_file", {
      sessionId: currentSession,
      path: process.env.FAKE_FS_PATH,
    });
    sessionUpdate({
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: result?.error
          ? ` fs-error:${result.error.message}`
          : ` fs:${String(result?.result?.content ?? "").slice(0, 40)}`,
      },
    });
  }

  if (process.env.FAKE_TERMINAL === "1") {
    const created = await request("terminal/create", {
      sessionId: currentSession,
      command: process.execPath,
      args: ["-e", "process.stdout.write('terminal-ok')"],
      cwd: process.cwd(),
      outputByteLimit: 1024,
    });
    const terminalId = created?.result?.terminalId;
    if (terminalId) {
      await request("terminal/wait_for_exit", { sessionId: currentSession, terminalId });
      const output = await request("terminal/output", { sessionId: currentSession, terminalId });
      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: ` term:${output?.result?.output ?? ""}` },
      });
      await request("terminal/release", { sessionId: currentSession, terminalId });
    } else {
      sessionUpdate({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: ` term-error:${created?.error?.message ?? "unknown"}` },
      });
    }
  }

  sessionUpdate({
    sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: " Done." },
  });
  respond({ stopReason: "end_turn" });
};

const handleNotification = (message) => {
  if (message.method === "session/cancel") {
    if (promptId !== null) {
      send({ jsonrpc: "2.0", id: promptId, result: { stopReason: "cancelled" } });
      promptId = null;
    }
  }
};

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (process.env.FAKE_MALFORMED === "1" && !malformedSent) {
    malformedSent = true;
    process.stdout.write("this is not json\n");
  }
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method) {
    if (message.id !== undefined) {
      void handleRequest(message);
    } else {
      handleNotification(message);
    }
    return;
  }
  if (message.id !== undefined) {
    const resolver = pending.get(message.id);
    pending.delete(message.id);
    resolver?.(message);
  }
});
