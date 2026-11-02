import type { DashboardSessionRecord } from "@slackboard/shared";
import { asString, type Database } from "./database.js";

export class AuthRepository {
  constructor(private readonly db: Database) {}

  create(
    input: {
      id: string;
      tokenHash: string;
      csrfToken: string;
      expiresAt: string;
    },
    now: string,
  ): void {
    this.db
      .prepare(
        "INSERT INTO auth_sessions (id,token_hash,csrf_token,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?,?)",
      )
      .run(input.id, input.tokenHash, input.csrfToken, now, input.expiresAt, now);
  }

  byTokenHash(tokenHash: string): DashboardSessionRecord | undefined {
    const row = this.db.prepare("SELECT * FROM auth_sessions WHERE token_hash = ?").get(tokenHash);
    if (!row) return undefined;
    return {
      id: asString(row.id),
      tokenHash: asString(row.token_hash),
      csrfToken: asString(row.csrf_token),
      createdAt: asString(row.created_at),
      expiresAt: asString(row.expires_at),
      lastSeenAt: asString(row.last_seen_at),
    };
  }

  touch(id: string, now: string): void {
    this.db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(now, id);
  }

  remove(id: string): void {
    this.db.prepare("DELETE FROM auth_sessions WHERE id = ?").run(id);
  }

  purgeExpired(now: string): number {
    return Number(
      this.db.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?").run(now).changes,
    );
  }
}
