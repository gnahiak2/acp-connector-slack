import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentCapabilitiesView, McpServerRecord } from "@slackboard/shared";

export interface McpResolution {
  servers: McpServer[];
  issues: string[];
}

const validEnvName = (name: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);

const isLocalUrl = (url: URL): boolean =>
  url.hostname === "localhost" ||
  url.hostname === "127.0.0.1" ||
  url.hostname === "::1" ||
  url.hostname === "[::1]";

export const buildMcpServers = (
  records: readonly McpServerRecord[],
  capabilities: AgentCapabilitiesView,
  sourceEnv: NodeJS.ProcessEnv,
  options: { allowInsecureHttp: boolean },
): McpResolution => {
  const servers: McpServer[] = [];
  const issues: string[] = [];
  for (const record of records) {
    if (!record.enabled) continue;
    if (record.transport === "stdio") {
      if (!record.command || !record.command.startsWith("/")) {
        issues.push(`MCP server ${record.name}: stdio command must be an absolute path`);
        continue;
      }
      const env: Array<{ name: string; value: string }> = [];
      let missing = false;
      for (const ref of record.envRefs) {
        if (!validEnvName(ref)) {
          issues.push(`MCP server ${record.name}: invalid environment reference ${ref}`);
          missing = true;
          continue;
        }
        const value = sourceEnv[ref];
        if (value === undefined) {
          issues.push(`MCP server ${record.name}: environment variable ${ref} is not set`);
          missing = true;
          continue;
        }
        env.push({ name: ref, value });
      }
      if (missing) continue;
      servers.push({
        name: record.name,
        command: record.command,
        args: record.args,
        env,
      });
      continue;
    }

    if (!record.url) {
      issues.push(`MCP server ${record.name}: ${record.transport} transport requires a URL`);
      continue;
    }
    let url: URL;
    try {
      url = new URL(record.url);
    } catch {
      issues.push(`MCP server ${record.name}: URL is invalid`);
      continue;
    }
    if (url.username || url.password) {
      issues.push(`MCP server ${record.name}: credentials are not allowed in the URL`);
      continue;
    }
    if (url.protocol !== "https:" && !(options.allowInsecureHttp && isLocalUrl(url))) {
      issues.push(`MCP server ${record.name}: only https URLs are allowed`);
      continue;
    }
    if (record.transport === "http" && !capabilities.mcp.http) {
      issues.push(`MCP server ${record.name}: agent does not support HTTP MCP transport`);
      continue;
    }
    if (record.transport === "sse" && !capabilities.mcp.sse) {
      issues.push(`MCP server ${record.name}: agent does not support SSE MCP transport`);
      continue;
    }
    const headers: Array<{ name: string; value: string }> = [];
    let missing = false;
    for (const header of record.headerRefs) {
      if (!header.name || /[\r\n]/.test(header.name)) {
        issues.push(`MCP server ${record.name}: invalid header name`);
        missing = true;
        continue;
      }
      if (!validEnvName(header.envVar)) {
        issues.push(`MCP server ${record.name}: invalid header environment reference`);
        missing = true;
        continue;
      }
      const value = sourceEnv[header.envVar];
      if (value === undefined) {
        issues.push(`MCP server ${record.name}: environment variable ${header.envVar} is not set`);
        missing = true;
        continue;
      }
      headers.push({ name: header.name, value });
    }
    if (missing) continue;
    servers.push({
      type: record.transport,
      name: record.name,
      url: record.url,
      headers,
    });
  }
  return { servers, issues };
};
