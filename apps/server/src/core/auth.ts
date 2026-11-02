import { createHash, timingSafeEqual } from "node:crypto";
import type { AppConfig, DashboardUser } from "@slackboard/shared";
import { newId, newToken, verifyPassword } from "@slackboard/shared";
import type { AuthRepository } from "../db/auth.js";

export const SESSION_COOKIE = "slackboard_session";
export const CSRF_HEADER = "x-slackboard-csrf";

export interface AuthResult {
  token: string;
  csrfToken: string;
  expiresAt: string;
  user: DashboardUser;
}

const hashToken = (token: string): string => createHash("sha256").update(token).digest("hex");

export class AuthService {
  constructor(
    private readonly config: AppConfig,
    private readonly repository: AuthRepository,
  ) {}

  login(username: string, password: string): AuthResult | undefined {
    if (username !== this.config.auth.adminUser) return undefined;
    if (!verifyPassword(password, this.config.auth)) return undefined;
    const now = new Date();
    const token = newToken();
    const csrfToken = newToken();
    const expiresAt = new Date(now.getTime() + this.config.auth.sessionTtlMs).toISOString();
    this.repository.create(
      {
        id: newId("auth"),
        tokenHash: hashToken(token),
        csrfToken,
        expiresAt,
      },
      now.toISOString(),
    );
    return {
      token,
      csrfToken,
      expiresAt,
      user: { name: this.config.auth.adminUser, role: "admin" },
    };
  }

  authenticate(token: string | undefined): { user: DashboardUser; csrfToken: string } | undefined {
    if (!token) return undefined;
    const session = this.repository.byTokenHash(hashToken(token));
    if (!session) return undefined;
    const now = new Date();
    if (new Date(session.expiresAt).getTime() <= now.getTime()) {
      this.repository.remove(session.id);
      return undefined;
    }
    this.repository.touch(session.id, now.toISOString());
    return {
      user: { name: this.config.auth.adminUser, role: "admin" },
      csrfToken: session.csrfToken,
    };
  }

  logout(token: string | undefined): void {
    if (!token) return;
    const session = this.repository.byTokenHash(hashToken(token));
    if (session) this.repository.remove(session.id);
  }

  verifyCsrf(expected: string, provided: string | undefined): boolean {
    if (!provided) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  purgeExpired(): number {
    return this.repository.purgeExpired(new Date().toISOString());
  }

  cookieOptions(): {
    httpOnly: true;
    sameSite: "strict";
    secure: boolean;
    path: string;
    maxAge: number;
  } {
    return {
      httpOnly: true,
      sameSite: "strict",
      secure: this.config.auth.secureCookies,
      path: "/",
      maxAge: Math.floor(this.config.auth.sessionTtlMs / 1000),
    };
  }
}
