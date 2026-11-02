import type { ProjectRecord } from "@slackboard/shared";
import { asJson, asOptionalString, asString, type Database } from "./database.js";

const map = (row: Record<string, unknown>): ProjectRecord => ({
  id: asString(row.id),
  name: asString(row.name),
  slug: asString(row.slug),
  localPath: asOptionalString(row.local_path),
  repository: asOptionalString(row.repository),
  defaultBranch: asString(row.default_branch),
  allowedChannels: asJson<string[]>(row.allowed_channels, []),
  allowedUsers: asJson<string[]>(row.allowed_users, []),
  archivedAt: asOptionalString(row.archived_at),
  createdAt: asString(row.created_at),
  updatedAt: asString(row.updated_at),
});

export interface ProjectInput {
  id: string;
  name: string;
  slug: string;
  localPath?: string;
  repository?: string;
  defaultBranch?: string;
  allowedChannels?: string[];
  allowedUsers?: string[];
}

export class ProjectRepository {
  constructor(private readonly db: Database) {}

  list(includeArchived = false): ProjectRecord[] {
    const sql = includeArchived
      ? "SELECT * FROM projects ORDER BY name COLLATE NOCASE"
      : "SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name COLLATE NOCASE";
    return this.db.prepare(sql).all().map((row) => map(row as Record<string, unknown>));
  }

  byId(id: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  bySlug(slug: string): ProjectRecord | undefined {
    const row = this.db.prepare("SELECT * FROM projects WHERE slug = ?").get(slug);
    return row ? map(row as Record<string, unknown>) : undefined;
  }

  create(input: ProjectInput, now: string): ProjectRecord {
    this.db
      .prepare(
        `INSERT INTO projects (id,name,slug,local_path,repository,default_branch,allowed_channels,allowed_users,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.name,
        input.slug,
        input.localPath ?? null,
        input.repository ?? null,
        input.defaultBranch ?? "main",
        JSON.stringify(input.allowedChannels ?? []),
        JSON.stringify(input.allowedUsers ?? []),
        now,
        now,
      );
    return this.byId(input.id)!;
  }

  update(
    id: string,
    patch: Partial<Omit<ProjectInput, "id">> & { archived?: boolean },
    now: string,
  ): ProjectRecord | undefined {
    const current = this.byId(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare(
        `UPDATE projects SET name=?, slug=?, local_path=?, repository=?, default_branch=?, allowed_channels=?, allowed_users=?, archived_at=?, updated_at=? WHERE id=?`,
      )
      .run(
        next.name,
        next.slug,
        next.localPath ?? null,
        next.repository ?? null,
        next.defaultBranch,
        JSON.stringify(next.allowedChannels),
        JSON.stringify(next.allowedUsers),
        patch.archived === undefined
          ? (current.archivedAt ?? null)
          : patch.archived
            ? now
            : null,
        now,
        id,
      );
    return this.byId(id);
  }
}
