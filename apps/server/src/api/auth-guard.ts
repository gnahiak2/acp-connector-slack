import type { FastifyReply, FastifyRequest } from "fastify";
import type { DashboardUser } from "@slackboard/shared";
import type { Services } from "../services.js";
import { CSRF_HEADER, SESSION_COOKIE } from "../core/auth.js";

declare module "fastify" {
  interface FastifyRequest {
    dashboardUser?: DashboardUser;
    dashboardCsrfToken?: string;
  }
}

export const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export const allowedOrigins = (services: Services): Set<string> => {
  const { config } = services;
  const origins = new Set<string>();
  if (config.publicUrl) origins.add(new URL(config.publicUrl).origin);
  origins.add(`http://${config.host}:${config.port}`);
  origins.add(`http://localhost:${config.port}`);
  origins.add(`http://127.0.0.1:${config.port}`);
  if (config.mode === "local") {
    origins.add("http://localhost:5173");
    origins.add("http://127.0.0.1:5173");
  }
  return origins;
};

export const originGuard = (services: Services) => {
  const allowed = allowedOrigins(services);
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const origin = request.headers.origin;
    if (origin && !allowed.has(origin)) {
      reply.code(403).send({ error: "Origin is not allowed" });
      return;
    }
    if (request.headers["sec-fetch-site"] === "cross-site") {
      reply.code(403).send({ error: "Cross-site request is not allowed" });
    }
  };
};

export const authGuard = (services: Services) => async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const config = (request.routeOptions?.config ?? {}) as { public?: boolean };
  if (config.public) return;
  const token = request.cookies[SESSION_COOKIE];
  const authenticated = services.auth.authenticate(token);
  if (!authenticated) {
    reply
      .code(401)
      .send({ error: "Authentication required" });
    return;
  }
  request.dashboardUser = authenticated.user;
  request.dashboardCsrfToken = authenticated.csrfToken;
  reply.header("cache-control", "no-store");
  if (MUTATING_METHODS.has(request.method)) {
    const provided = request.headers[CSRF_HEADER];
    if (typeof provided !== "string" || !services.auth.verifyCsrf(authenticated.csrfToken, provided)) {
      reply.code(403).send({ error: "CSRF token is invalid" });
    }
  }
};

export const requireUser = (request: FastifyRequest): DashboardUser => {
  if (!request.dashboardUser) throw new Error("Authentication middleware did not run");
  return request.dashboardUser;
};

export const actorFor = (request: FastifyRequest) => {
  const user = requireUser(request);
  return { kind: "dashboard" as const, id: user.name, name: user.name, role: user.role };
};
