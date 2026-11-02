import type { McpServerRecord } from "@slackboard/shared";
import { newId } from "@slackboard/shared";
import { mcpInputSchema } from "@slackboard/integrations";
import type { Repositories } from "../db/index.js";
import type { AuditService } from "./audit.js";

export class McpValidationError extends Error {}
export class McpNotFoundError extends Error {}

export class McpService {
  constructor(
    private readonly repos: Repositories,
    private readonly audit: AuditService,
  ) {}

  list(): McpServerRecord[] {
    return this.repos.mcp.list();
  }

  create(input: unknown, actor: string): McpServerRecord {
    const parsed = mcpInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new McpValidationError(
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    if (this.repos.mcp.list().some((server) => server.name === parsed.data.name)) {
      throw new McpValidationError("An MCP server with that name already exists");
    }
    const record = this.repos.mcp.create(
      { id: newId("mcp"), ...parsed.data },
      new Date().toISOString(),
    );
    this.audit.record({
      actor,
      action: "mcp.created",
      targetType: "mcp",
      targetId: record.id,
      detail: { name: record.name, transport: record.transport },
    });
    return record;
  }

  update(id: string, input: unknown, actor: string): McpServerRecord {
    const current = this.repos.mcp.byId(id);
    if (!current) throw new McpNotFoundError("MCP server not found");
    const parsed = mcpInputSchema.safeParse({
      name: current.name,
      transport: current.transport,
      command: current.command,
      args: current.args,
      envRefs: current.envRefs,
      url: current.url,
      headerRefs: current.headerRefs,
      enabled: current.enabled,
      ...((input ?? {}) as Record<string, unknown>),
    });
    if (!parsed.success) {
      throw new McpValidationError(
        parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "),
      );
    }
    const duplicate = this.repos.mcp
      .list()
      .find((server) => server.name === parsed.data.name && server.id !== id);
    if (duplicate) throw new McpValidationError("An MCP server with that name already exists");
    const updated = this.repos.mcp.update(id, parsed.data, new Date().toISOString())!;
    this.audit.record({
      actor,
      action: "mcp.updated",
      targetType: "mcp",
      targetId: id,
      detail: { name: updated.name, transport: updated.transport, enabled: updated.enabled },
    });
    return updated;
  }

  remove(id: string, actor: string): void {
    const current = this.repos.mcp.byId(id);
    if (!current) throw new McpNotFoundError("MCP server not found");
    this.repos.mcp.remove(id);
    this.audit.record({
      actor,
      action: "mcp.deleted",
      targetType: "mcp",
      targetId: id,
      detail: { name: current.name },
    });
  }
}
