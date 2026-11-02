import type {
  SessionAccessPolicy,
  SessionRecord,
  SessionStatus,
  SessionSummary,
} from "@slackboard/shared";
import { asJson, asNumber, asOptionalString, asString, type Database } from "./database.js";

const mapSession = (row: Record<string, unknown>): SessionRecord => ({
  id: asString(row.id),
  origin: asString(row.origin) === "slack" ? "slack" : "dashboard",
  teamId: asOptionalString(row.team_id),
  channelId: asOptionalString(row.channel_id),
  threadTs: asOptionalString(row.thread_ts),
  projectId: asString(row.project_id),
  agentId: asString(row.agent_id),
  creatorId: asString(row.creator_id),
  status: asString(row.status) as SessionStatus,
  title: asString(row.title),
  acpSessionId: asOptionalString(row.acp_session_id),
  workspacePath: asString(row.workspace_path),
  accessPolicy: asJson<SessionAccessPolicy>(row.access_policy, { userIds: [] }),
  createdAt: asString(row.created_at),
  updatedAt: asString(row.updated_at),
  lastActivityAt: asString(row.last_activity_at),
  archivedAt: asOptionalString(row.archived_at),
  lastError: asOptionalString(row.last_error),
});

const mapSummary = (row: Record<string, unknown>): SessionSummary => ({
  ...mapSession(row),
  projectName: asString(row.project_name),
  agentName: asString(row.agent_name),
  pendingApprovalCount: asNumber(row.pending_approval_count),
  lastEventAt: asOptionalString(row.last_event_at),
});

export interface SessionInput {
  id: string;
  origin: "slack" | "dashboard";
  teamId?: string;
  channelId?: string;
  threadTs?: string;
  projectId: string;
  agentId: string;
  creatorId: string;
  title: string;
  workspacePath: string;
  accessPolicy: SessionAccessPolicy;
}

export interface SessionFilters {
  status?: SessionStatus;
  projectId?: string;
  agentId?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

const SUMMARY_SELECT = `
  SELECT s.*,
    p.name AS project_name,
    a.name AS agent_name,
    (SELECT COUNT(*) FROM approvals ap WHERE ap.session_id = s.id AND ap.status = 'pending') AS pending_approval_count,
    (SELECT MAX(e.created_at) FROM events e WHERE e.session_id = s.id) AS last_event_at
  FROM sessions s
  JOIN projects p ON p.id = s.project_id
  JOIN agents a ON a.id = s.agent_id
`;

export class SessionRepository {
  constructor(private readonly db: Database) {}

  create(input: SessionInput, now: string): SessionRecord {
    this.db
      .prepare(
        `INSERT INTO sessions (id,origin,team_id,channel_id,thread_ts,project_id,agent_id,creator_id,status,title,workspace_path,access_policy,created_at,updated_at,last_activity_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        input.id,
        input.origin,
        input.teamId ?? null,
        input.channelId ?? null,
        input.threadTs ?? null,
        input.projectId,
        input.agentId,
        input.creatorId,
        "idle",
        input.title,
        input.workspacePath,
        JSON.stringify(input.accessPolicy),
        now,
        now,
        now,
      );
    return this.byId(input.id)!;
  }

  byId(id: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? mapSession(row as Record<string, unknown>) : undefined;
  }

  byThread(teamId: string, channelId: string, threadTs: string): SessionRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM sessions WHERE team_id = ? AND channel_id = ? AND thread_ts = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(teamId, channelId, threadTs);
    return row ? mapSession(row as Record<string, unknown>) : undefined;
  }

  latestForChannel(channelId: string, creatorId?: string): SessionRecord | undefined {
    const row = creatorId
      ? this.db
          .prepare(
            "SELECT * FROM sessions WHERE channel_id = ? AND creator_id = ? ORDER BY last_activity_at DESC LIMIT 1",
          )
          .get(channelId, creatorId)
      : this.db
          .prepare(
            "SELECT * FROM sessions WHERE channel_id = ? ORDER BY last_activity_at DESC LIMIT 1",
          )
          .get(channelId);
    return row ? mapSession(row as Record<string, unknown>) : undefined;
  }

  list(filters: SessionFilters = {}): SessionSummary[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filters.status) {
      where.push("s.status = ?");
      params.push(filters.status);
    }
    if (filters.projectId) {
      where.push("s.project_id = ?");
      params.push(filters.projectId);
    }
    if (filters.agentId) {
      where.push("s.agent_id = ?");
      params.push(filters.agentId);
    }
    if (filters.query) {
      where.push("(s.title LIKE ? OR s.id LIKE ? OR s.creator_id LIKE ?)");
      const like = `%${filters.query}%`;
      params.push(like, like, like);
    }
    const limit = Math.min(Math.max(filters.limit ?? 50, 1), 200);
    const offset = Math.max(filters.offset ?? 0, 0);
    const sql = `${SUMMARY_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY s.last_activity_at DESC LIMIT ? OFFSET ?`;
    return this.db
      .prepare(sql)
      .all(...params, limit, offset)
      .map((row) => mapSummary(row as Record<string, unknown>));
  }

  summaryById(id: string): SessionSummary | undefined {
    const row = this.db.prepare(`${SUMMARY_SELECT} WHERE s.id = ?`).get(id);
    return row ? mapSummary(row as Record<string, unknown>) : undefined;
  }

  count(): number {
    return asNumber(this.db.prepare("SELECT COUNT(*) AS c FROM sessions").get()?.c);
  }

  updateStatus(
    id: string,
    status: SessionStatus,
    now: string,
    lastError?: string | null,
  ): SessionRecord | undefined {
    this.db
      .prepare(
        "UPDATE sessions SET status = ?, updated_at = ?, last_activity_at = ?, last_error = ? WHERE id = ?",
      )
      .run(status, now, now, lastError ?? null, id);
    return this.byId(id);
  }

  touch(id: string, now: string): void {
    this.db.prepare("UPDATE sessions SET last_activity_at = ?, updated_at = ? WHERE id = ?").run(
      now,
      now,
      id,
    );
  }

  setAcpSessionId(id: string, acpSessionId: string | null, now: string): void {
    this.db
      .prepare("UPDATE sessions SET acp_session_id = ?, updated_at = ? WHERE id = ?")
      .run(acpSessionId, now, id);
  }

  setWorkspace(id: string, workspacePath: string, now: string): void {
    this.db
      .prepare("UPDATE sessions SET workspace_path = ?, updated_at = ? WHERE id = ?")
      .run(workspacePath, now, id);
  }

  setTitle(id: string, title: string, now: string): void {
    this.db.prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?").run(title, now, id);
  }

  markInFlightInterrupted(now: string): SessionRecord[] {
    const ids = this.db
      .prepare(
        "SELECT id FROM sessions WHERE status IN ('running','awaiting_approval')",
      )
      .all()
      .map((row) => asString(row.id));
    const update = this.db.prepare(
      "UPDATE sessions SET status = 'interrupted', updated_at = ?, last_activity_at = ?, last_error = ? WHERE id = ?",
    );
    this.db.transaction(() => {
      for (const id of ids) update.run(now, now, "Interrupted by server restart", id);
    });
    return ids.map((id) => this.byId(id)).filter((item): item is SessionRecord => Boolean(item));
  }

  sessionSkillIds(id: string): string[] {
    return this.db
      .prepare("SELECT skill_id FROM session_skills WHERE session_id = ?")
      .all(id)
      .map((row) => asString(row.skill_id));
  }
}
