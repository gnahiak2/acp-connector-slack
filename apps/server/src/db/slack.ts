import { asOptionalString, type Database } from "./database.js";

export class SlackRepository {
  constructor(private readonly db: Database) {}

  claimEvent(eventKey: string, now: string): boolean {
    const result = this.db
      .prepare(
        "INSERT INTO slack_dedupe (event_key, received_at) VALUES (?, ?) ON CONFLICT(event_key) DO NOTHING",
      )
      .run(eventKey, now);
    return Number(result.changes) === 1;
  }

  releaseEvent(eventKey: string): void {
    this.db.prepare("DELETE FROM slack_dedupe WHERE event_key = ?").run(eventKey);
  }

  purgeDedupeBefore(cutoff: string): number {
    return Number(
      this.db.prepare("DELETE FROM slack_dedupe WHERE received_at < ?").run(cutoff).changes,
    );
  }

  channelDefaults(channelId: string): { agentId?: string; projectId?: string } | undefined {
    const row = this.db.prepare("SELECT * FROM channel_defaults WHERE channel_id = ?").get(channelId);
    if (!row) return undefined;
    return {
      agentId: asOptionalString(row.agent_id),
      projectId: asOptionalString(row.project_id),
    };
  }

  setChannelDefaults(
    channelId: string,
    input: { agentId?: string; projectId?: string },
    now: string,
  ): void {
    const existing = this.channelDefaults(channelId);
    this.db
      .prepare(
        `INSERT INTO channel_defaults (channel_id,agent_id,project_id,updated_at) VALUES (?,?,?,?)
         ON CONFLICT(channel_id) DO UPDATE SET agent_id=excluded.agent_id, project_id=excluded.project_id, updated_at=excluded.updated_at`,
      )
      .run(
        channelId,
        input.agentId ?? existing?.agentId ?? null,
        input.projectId ?? existing?.projectId ?? null,
        now,
      );
  }
}
