import type { McpServerRecord } from "@slackboard/shared";
import { asBoolean, asJson, asOptionalString, asString, type Database } from "./database.js";

const map = (row: Record<string, unknown>): McpServerRecord => ({
  id: asString(row.id),
  name: asString(row.name),
  transport: asString(row.transport) as McpServerRecord["transport"],
  command: asOptionalString(row.command),
  args: asJson<string[]>(row.args, []),
  envRefs: asJson<string[]>(row.env_refs, []),
  url: asOptionalString(row.url),
  headerRefs: asJson<Array<{ name: string; envVar: string }>>(row.header_refs, []),
  enabled: asBoolean(row.enabled),
  createdAt: asString(row.created_at),
  updatedAt: asString(row.updated_at),
});

export interface McpServerInput {
  id: string;
  name: string;
  transport: McpServerRecord["transport"];
  command?: string;
  args?: string[];
  envRefs?: string[];
  url?: string;
  headerRefs?: Array<{ name: string; envVar: string }>;
  enabled?: boolean;
}

export class McpRepository {
  constructor(private readonly db: Database) {}

  list(): McpServerRecord[] {
    return this.db
      .prepare("SELECT * FROM mcp_servers ORDER BY name COLLATE NOCASE")
      .all()
      .map((row) => map(row as Record<string, unknown>));
  }

  byId(id: string): McpServerRecord | undefined {
    const row = this.db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  create(input: McpServerInput, now: string): McpServerRecord {
    this.db
      .prepare(
        `INSERT INTO mcp_servers (id,name,transport,command,args,env_refs,url,header_refs,enabled,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.name,
        input.transport,
        input.command ?? null,
        JSON.stringify(input.args ?? []),
        JSON.stringify(input.envRefs ?? []),
        input.url ?? null,
        JSON.stringify(input.headerRefs ?? []),
        input.enabled === false ? 0 : 1,
        now,
        now,
      );
    return this.byId(input.id)!;
  }

  update(
    id: string,
    patch: Partial<Omit<McpServerInput, "id">>,
    now: string,
  ): McpServerRecord | undefined {
    const current = this.byId(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE mcp_servers SET name=?, transport=?, command=?, args=?, env_refs=?, url=?, header_refs=?, enabled=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.name,
        next.transport,
        next.command ?? null,
        JSON.stringify(next.args),
        JSON.stringify(next.envRefs),
        next.url ?? null,
        JSON.stringify(next.headerRefs),
        next.enabled ? 1 : 0,
        now,
        id,
      );
    return this.byId(id);
  }

  remove(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id).changes) === 1;
  }
}
