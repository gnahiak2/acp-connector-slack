import type { SkillRecord, SkillReference, SkillStatus } from "@slackboard/shared";
import { asJson, asString, type Database } from "./database.js";

const map = (row: Record<string, unknown>): SkillRecord => ({
  id: asString(row.id),
  name: asString(row.name),
  slug: asString(row.slug),
  description: asString(row.description),
  version: asString(row.version),
  content: asString(row.content),
  references: asJson<SkillReference[]>(row.refs, []),
  status: asString(row.status) as SkillStatus,
  source: asString(row.source) === "bundled" ? "bundled" : "custom",
  createdBy: asString(row.created_by),
  createdAt: asString(row.created_at),
  updatedAt: asString(row.updated_at),
});

export interface SkillInput {
  id: string;
  name: string;
  slug: string;
  description: string;
  version: string;
  content: string;
  references?: SkillReference[];
  status: SkillStatus;
  source: "bundled" | "custom";
  createdBy: string;
}

export class SkillRepository {
  constructor(private readonly db: Database) {}

  list(): SkillRecord[] {
    return this.db
      .prepare("SELECT * FROM skills ORDER BY name COLLATE NOCASE")
      .all()
      .map((row) => map(row as Record<string, unknown>));
  }

  enabled(): SkillRecord[] {
    return this.db
      .prepare("SELECT * FROM skills WHERE status = 'enabled' ORDER BY name COLLATE NOCASE")
      .all()
      .map((row) => map(row as Record<string, unknown>));
  }

  byId(id: string): SkillRecord | undefined {
    const row = this.db.prepare("SELECT * FROM skills WHERE id = ?").get(id);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  bySlug(slug: string): SkillRecord | undefined {
    const row = this.db.prepare("SELECT * FROM skills WHERE slug = ?").get(slug);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  forSession(sessionId: string): SkillRecord[] {
    return this.db
      .prepare(
        `SELECT sk.* FROM session_skills ss JOIN skills sk ON sk.id = ss.skill_id
         WHERE ss.session_id = ? AND sk.status = 'enabled' ORDER BY sk.name COLLATE NOCASE`,
      )
      .all(sessionId)
      .map((row) => map(row as Record<string, unknown>));
  }

  create(input: SkillInput, now: string): SkillRecord {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO skills (id,name,slug,description,version,content,refs,status,source,created_by,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          input.id,
          input.name,
          input.slug,
          input.description,
          input.version,
          input.content,
          JSON.stringify(input.references ?? []),
          input.status,
          input.source,
          input.createdBy,
          now,
          now,
        );
      this.addVersion(input.id, input.version, input.content, input.references ?? [], input.createdBy, now);
    });
    return this.byId(input.id)!;
  }

  update(
    id: string,
    input: {
      name?: string;
      description?: string;
      version: string;
      content: string;
      references?: SkillReference[];
      status?: SkillStatus;
    },
    now: string,
  ): SkillRecord | undefined {
    const current = this.byId(id);
    if (!current) return undefined;
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE skills SET name=?, description=?, version=?, content=?, refs=?, status=?, updated_at=? WHERE id=?`,
        )
        .run(
          input.name ?? current.name,
          input.description ?? current.description,
          input.version,
          input.content,
          JSON.stringify(input.references ?? current.references),
          input.status ?? current.status,
          now,
          id,
        );
      this.addVersion(
        id,
        input.version,
        input.content,
        input.references ?? current.references,
        current.createdBy,
        now,
      );
    });
    return this.byId(id);
  }

  setStatus(id: string, status: SkillStatus, now: string): SkillRecord | undefined {
    this.db.prepare("UPDATE skills SET status = ?, updated_at = ? WHERE id = ?").run(status, now, id);
    return this.byId(id);
  }

  private addVersion(
    skillId: string,
    version: string,
    content: string,
    references: SkillReference[],
    createdBy: string,
    now: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO skill_versions (id,skill_id,version,content,refs,created_by,created_at)
         VALUES (?,?,?,?,?,?,?) ON CONFLICT(skill_id,version) DO UPDATE SET content=excluded.content, refs=excluded.refs, created_at=excluded.created_at`,
      )
      .run(
        `skv_${skillId}_${version}`.replaceAll(/[^A-Za-z0-9_-]/g, "_"),
        skillId,
        version,
        content,
        JSON.stringify(references),
        createdBy,
        now,
      );
  }

  versions(skillId: string): Array<{ version: string; createdAt: string; createdBy: string }> {
    return this.db
      .prepare(
        "SELECT version, created_at, created_by FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC",
      )
      .all(skillId)
      .map((row) => ({
        version: asString(row.version),
        createdAt: asString(row.created_at),
        createdBy: asString(row.created_by),
      }));
  }

  attach(sessionId: string, skillId: string, now: string): void {
    this.db
      .prepare(
        "INSERT INTO session_skills (session_id, skill_id, enabled_at) VALUES (?,?,?) ON CONFLICT(session_id,skill_id) DO NOTHING",
      )
      .run(sessionId, skillId, now);
  }

  detach(sessionId: string, skillId: string): void {
    this.db
      .prepare("DELETE FROM session_skills WHERE session_id = ? AND skill_id = ?")
      .run(sessionId, skillId);
  }

  seedBundled(input: SkillInput, now: string): void {
    const existing = this.bySlug(input.slug);
    if (!existing) {
      this.create(input, now);
      return;
    }
    if (existing.source !== "bundled") return;
    if (existing.version === input.version) return;
    this.update(
      existing.id,
      {
        name: input.name,
        description: input.description,
        version: input.version,
        content: input.content,
        references: input.references,
        status: existing.status,
      },
      now,
    );
  }
}
