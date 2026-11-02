import { existsSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import type { Services } from "./services.js";
import { registerApiRoutes } from "./api/routes.js";
import { errorStatus } from "./api/errors.js";
import { loggerOptions } from "./logger.js";

export const buildApp = async (services: Services): Promise<FastifyInstance> => {
  const { config } = services;
  const webDist = config.webDist ?? resolve(process.cwd(), "apps/web/dist");
  const hasWeb = existsSync(resolve(webDist, "index.html"));

  const app = Fastify({
    logger: loggerOptions(config.logLevel),
    trustProxy: config.trustProxy,
    bodyLimit: Math.max(config.limits.maxMessageBytes * 2, 1_048_576),
    forceCloseConnections: true,
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    allowList: (request) => request.url === "/healthz",
  });
  await registerApiRoutes(app, services);

  app.get("/healthz", async (_request, reply) => {
    try {
      services.db.prepare("SELECT 1 AS ok").get();
      return { ok: true, version: "0.1.0" };
    } catch {
      reply.code(503);
      return { ok: false };
    }
  });

  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist,
      prefix: "/",
      decorateReply: true,
    });
  }

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("x-frame-options", "DENY");
    reply.header("referrer-policy", "no-referrer");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("permissions-policy", "camera=(), microphone=(), geolocation=()");
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (contentType.includes("text/html")) {
      reply.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      );
    }
    if (config.publicUrl?.startsWith("https://")) {
      reply.header("strict-transport-security", "max-age=31536000; includeSubDomains");
    }
    return payload;
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/healthz")) {
      reply.code(404).send({ error: "Not found" });
      return;
    }
    if (hasWeb && request.method === "GET" && !request.url.includes(".")) {
      return reply.sendFile("index.html");
    }
    reply.code(404).send({ error: "Not found" });
  });

  app.setErrorHandler((error, request, reply) => {
    const { status, message } = errorStatus(error);
    if (status >= 500) {
      request.log.error({ err: error }, "request failed");
    }
    reply.code(status).send({ error: status >= 500 ? "Internal server error" : message });
  });

  return app;
};
