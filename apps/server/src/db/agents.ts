import type { AgentProfile } from "@slackboard/shared";
import { asBoolean, asJson, asOptionalString, asString, type Database } from "./database.js";
import type { AgentRecord } from "@slackboard/shared";

const map = (row: Record<string, unknown>): AgentRecord => ({
  id: asString(row.id),
  name: asString(row.name),
  description: asOptionalString(row.description),
  executable: asString(row.executable),
  args: asJson<string[]>(row.args, []),
  env: asJson<string[]>(row.env, []),
  runner: asString(row.runner) === "container" ? "container" : "local",
  authentication: asOptionalString(row.authentication),
  enabled: asBoolean(row.enabled),
  preset: asBoolean(row.preset),
  createdAt: asString(row.created_at),
  updatedAt: asString(row.updated_at),
});

export class AgentRepository {
  constructor(private readonly db: Database) {}

  seed(profiles: AgentProfile[], now: string): void {
    const insert = this.db.prepare(
      `INSERT INTO agents (id,name,description,executable,args,env,runner,authentication,enabled,preset,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
    );
    this.db.transaction(() => {
      for (const profile of profiles) {
        insert.run(
          profile.id,
          profile.name,
          profile.description ?? null,
          profile.executable,
          JSON.stringify(profile.args),
          JSON.stringify(profile.env),
          profile.runner,
          profile.authentication ?? null,
          profile.enabled ? 1 : 0,
          profile.preset ? 1 : 0,
          now,
          now,
        );
      }
    });
  }

  list(includeDisabled = true): AgentRecord[] {
    const sql = includeDisabled
      ? "SELECT * FROM agents ORDER BY name COLLATE NOCASE"
      : "SELECT * FROM agents WHERE enabled = 1 ORDER BY name COLLATE NOCASE";
    return this.db.prepare(sql).all().map((row) => map(row as Record<string, unknown>));
  }

  byId(id: string): AgentRecord | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  create(input: AgentProfile, now: string): AgentRecord {
    this.db
      .prepare(
        `INSERT INTO agents (id,name,description,executable,args,env,runner,authentication,enabled,preset,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.name,
        input.description ?? null,
        input.executable,
        JSON.stringify(input.args),
        JSON.stringify(input.env),
        input.runner,
        input.authentication ?? null,
        input.enabled ? 1 : 0,
        input.preset ? 1 : 0,
        now,
        now,
      );
    return this.byId(input.id)!;
  }

  update(
    id: string,
    patch: Partial<Omit<AgentProfile, "id">>,
    now: string,
  ): AgentRecord | undefined {
    const current = this.byId(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE agents SET name=?, description=?, executable=?, args=?, env=?, runner=?, authentication=?, enabled=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.name,
        next.description ?? null,
        next.executable,
        JSON.stringify(next.args),
        JSON.stringify(next.env),
        next.runner,
        next.authentication ?? null,
        next.enabled ? 1 : 0,
        now,
        id,
      );
    return this.byId(id);
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    return Number(result.changes) === 1;
  }
}
