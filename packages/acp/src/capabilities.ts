import type { AgentCapabilities } from "@agentclientprotocol/sdk";
import type { AgentCapabilitiesView, DoctorReport } from "@slackboard/shared";

export const capabilityView = (caps: AgentCapabilities | undefined): AgentCapabilitiesView => ({
  loadSession: caps?.loadSession === true,
  prompt: {
    image: caps?.promptCapabilities?.image === true,
    audio: caps?.promptCapabilities?.audio === true,
    embeddedContext: caps?.promptCapabilities?.embeddedContext === true,
  },
  mcp: {
    http: caps?.mcpCapabilities?.http === true,
    sse: caps?.mcpCapabilities?.sse === true,
  },
  session: {
    list: Boolean(caps?.sessionCapabilities?.list),
    delete: Boolean(caps?.sessionCapabilities?.delete),
    resume: Boolean(caps?.sessionCapabilities?.resume),
    close: Boolean(caps?.sessionCapabilities?.close),
    additionalDirectories: Boolean(caps?.sessionCapabilities?.additionalDirectories),
  },
  logout: Boolean(caps?.auth?.logout),
});

export const unsupportedFeatures = (view: AgentCapabilitiesView): string[] => {
  const unsupported: string[] = [];
  if (!view.loadSession) unsupported.push("session/load (restart continuation)");
  if (!view.session.resume) unsupported.push("session/resume");
  if (!view.session.close) unsupported.push("session/close");
  if (!view.session.list) unsupported.push("session/list");
  if (!view.session.delete) unsupported.push("session/delete");
  if (!view.session.additionalDirectories) unsupported.push("additional workspace roots");
  if (!view.prompt.image) unsupported.push("image prompts");
  if (!view.prompt.audio) unsupported.push("audio prompts");
  if (!view.prompt.embeddedContext) unsupported.push("embedded resource prompts");
  if (!view.mcp.http) unsupported.push("HTTP MCP transports");
  if (!view.mcp.sse) unsupported.push("SSE MCP transports");
  if (!view.logout) unsupported.push("agent logout");
  return unsupported;
};

export const emptyDoctorReport = (agentId: string, executable: string, args: string[]): DoctorReport => ({
  ok: false,
  agentId,
  executable,
  args,
  authMethods: [],
  unsupported: [],
});
