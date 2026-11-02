import type { FastifyReply, FastifyRequest } from "fastify";
import type { PublicEvent } from "@slackboard/shared";
import type { Services } from "../services.js";
import type { Actor } from "../core/access.js";
import { SessionNotFoundError } from "../core/session-service.js";

const HEARTBEAT_MS = 15_000;

const writeEvent = (reply: FastifyReply, event: PublicEvent): void => {
  reply.raw.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
};

export const streamSession = (
  services: Services,
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): void => {
  const query = request.query as { after?: string };
  const user = request.dashboardUser;
  if (!user) {
    reply.code(401).send({ error: "Authentication required" });
    return;
  }
  const actor: Actor = { kind: "dashboard", id: user.name, name: user.name, role: user.role };
  let session;
  try {
    session = services.sessions.getForActor(request.params.id, actor);
  } catch (error) {
    if (error instanceof SessionNotFoundError) {
      reply.code(404).send({ error: "Session not found" });
      return;
    }
    reply.code(403).send({ error: "Not authorised" });
    return;
  }
  const lastEventId = request.headers["last-event-id"];
  const parsed = Number.parseInt(
    typeof lastEventId === "string"
      ? lastEventId
      : (query.after ?? "0"),
    10,
  );
  const afterSeq = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  const maxSeq = services.events.maxSeq(session.id);
  const limit = 1_000;
  const replayFrom = Math.max(afterSeq, Math.max(0, maxSeq - limit));

  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    "x-content-type-options": "nosniff",
  });
  reply.raw.write("retry: 3000\n\n");
  if (maxSeq - afterSeq > limit) {
    reply.raw.write(
      `event: replay-truncated\ndata: ${JSON.stringify({ from: replayFrom, max: maxSeq })}\n\n`,
    );
  }
  for (const event of services.events.replay(session.id, replayFrom - 1, limit)) {
    writeEvent(reply, event);
  }

  const unsubscribe = services.events.subscribe((event) => {
    if (event.sessionId !== session.id) return;
    try {
      writeEvent(reply, event);
    } catch {
      unsubscribe();
    }
  });
  const heartbeat = setInterval(() => {
    try {
      reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
    } catch {
      cleanup();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
    try {
      reply.raw.end();
    } catch {
      // Already closed.
    }
  };
  request.raw.on("close", cleanup);
  request.raw.on("error", cleanup);
  reply.raw.on("close", cleanup);
};
