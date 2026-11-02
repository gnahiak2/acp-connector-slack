import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  agentProfileSchema,
  APP_VERSION,
  type AgentProfile,
  type SessionStatus,
} from "@slackboard/shared";
import { createRunner, type Runner } from "@slackboard/runner";
import type { Services } from "../services.js";
import { actorFor, authGuard, originGuard } from "./auth-guard.js";
import { SESSION_COOKIE } from "../core/auth.js";
import { streamSession } from "./sse.js";
import { HttpError, parseBody } from "./errors.js";
import { SessionValidationError } from "../core/session-service.js";

const statusValues = [
  "idle",
  "queued",
  "running",
  "awaiting_approval",
  "completed",
  "cancelled",
  "failed",
  "interrupted",
  "stopped",
] as const;

const loginSchema = z.object({
  username: z.string().min(1).max(200),
  password: z.string().min(1).max(2000),
});

const sessionListSchema = z.object({
  status: z.enum(statusValues).optional(),
  projectId: z.string().optional(),
  agentId: z.string().optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const createSessionSchema = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  title: z.string().max(200).optional(),
});

const promptSchema = z.object({
  text: z.string().min(1).max(200_000),
});

const titleSchema = z.object({ title: z.string().min(1).max(200) });
const resolveSchema = z.object({ optionId: z.string().min(1).max(200) });
const attachSkillSchema = z.object({ skillId: z.string().min(1) });

const projectSchema = z
  .object({
    name: z.string().min(1).max(120),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    localPath: z.string().max(4096).optional(),
    repository: z.string().max(4096).optional(),
    defaultBranch: z.string().max(200).default("main"),
    allowedChannels: z.array(z.string().max(100)).max(100).default([]),
    allowedUsers: z.array(z.string().max(100)).max(100).default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.localPath && !value.repository) {
      ctx.addIssue({
        code: "custom",
        path: ["localPath"],
        message: "localPath or repository is required",
      });
    }
  });

const projectPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  localPath: z.string().max(4096).optional(),
  repository: z.string().max(4096).optional(),
  defaultBranch: z.string().max(200).optional(),
  allowedChannels: z.array(z.string().max(100)).max(100).optional(),
  allowedUsers: z.array(z.string().max(100)).max(100).optional(),
  archived: z.boolean().optional(),
});

const skillReferenceSchema = z.object({
  path: z.string().min(1).max(200),
  content: z.string().max(262_144),
});

const skillCreateSchema = z.object({
  name: z.string().min(1).max(64),
  description: z.string().min(1).max(1024),
  version: z.string().min(1).max(32).optional(),
  content: z.string().min(1).max(262_144),
  references: z.array(skillReferenceSchema).max(50).optional(),
});

const skillPatchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  description: z.string().min(1).max(1024).optional(),
  version: z.string().min(1).max(32).optional(),
  content: z.string().min(1).max(262_144).optional(),
  references: z.array(skillReferenceSchema).max(50).optional(),
});

const memoryCreateSchema = z.object({
  content: z.string().min(1).max(32_768),
  provenance: z.string().max(300).optional(),
  proposal: z.boolean().default(false),
  sessionId: z.string().optional(),
});

const memoryPatchSchema = z.object({ content: z.string().min(1).max(32_768) });

const prSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(20_000).default(""),
  repository: z.string().max(4096).optional(),
  base: z.string().max(200).optional(),
  head: z.string().max(200).optional(),
});

const agentPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  executable: z.string().min(1).max(4096).optional(),
  args: z.array(z.string()).max(64).optional(),
  env: z.array(z.string()).max(64).optional(),
  runner: z.enum(["local", "container"]).optional(),
  authentication: z.string().max(4000).optional(),
  enabled: z.boolean().optional(),
});

const githubQuerySchema = z.object({
  repository: z.string().min(1),
  state: z.enum(["open", "closed", "all"]).optional(),
});

let healthCache: { runner: { ok: boolean; detail: string }; at: number } | undefined;

const runnerHealth = async (services: Services): Promise<{ ok: boolean; detail: string }> => {
  if (healthCache && Date.now() - healthCache.at < 10_000) return healthCache.runner;
  let runner: Runner | undefined;
  try {
    runner = createRunner(services.config);
    const health = await runner.health();
    healthCache = { runner: health, at: Date.now() };
    return health;
  } catch (error) {
    const health = { ok: false, detail: (error as Error).message };
    healthCache = { runner: health, at: Date.now() };
    return health;
  }
};

const validateProjectInput = (
  services: Services,
  input: z.infer<typeof projectSchema>,
): void => {
  if (input.localPath) {
    if (!isAbsolute(input.localPath)) {
      throw new SessionValidationError("Project local path must be absolute");
    }
    if (!existsSync(input.localPath) || !statSync(input.localPath).isDirectory()) {
      throw new SessionValidationError("Project local path does not exist or is not a directory");
    }
  }
  if (input.repository) {
    services.workspace.normalizeRepositoryUrl(input.repository);
  }
};

export const registerApiRoutes = async (
  app: FastifyInstance,
  services: Services,
): Promise<void> => {
  await app.register(
    async (api) => {
      api.addHook("onRequest", originGuard(services));
      api.addHook("preHandler", authGuard(services));

      api.get("/health", async () => ({
        ok: true,
        version: APP_VERSION,
        mode: services.config.mode,
        database: { ok: true },
        slack: {
          configured: services.health.slackConfigured,
          connected: services.health.slackConnected,
          lastError: services.health.slackLastError,
        },
        runner: {
          type: services.config.runner.type,
          ...(await runnerHealth(services)),
        },
        agents: {
          total: services.repos.agents.list().length,
          enabled: services.repos.agents.list(false).length,
        },
      }));

      api.post(
        "/auth/login",
        { config: { public: true, rateLimit: { max: 5, timeWindow: "1 minute" } } },
        async (request, reply) => {
          const body = parseBody(loginSchema, request.body);
          const result = services.auth.login(body.username, body.password);
          if (!result) {
            services.audit.record({
              actor: body.username.slice(0, 100),
              action: "auth.login_failed",
              targetType: "auth",
            });
            reply.code(401).send({ error: "Invalid credentials" });
            return;
          }
          services.audit.record({
            actor: result.user.name,
            action: "auth.login",
            targetType: "auth",
          });
          reply.setCookie(SESSION_COOKIE, result.token, services.auth.cookieOptions());
          return {
            user: result.user,
            csrfToken: result.csrfToken,
            expiresAt: result.expiresAt,
          };
        },
      );

      api.get("/auth/session", async (request) => ({
        user: request.dashboardUser,
        csrfToken: request.dashboardCsrfToken,
      }));

      api.post("/auth/logout", async (request, reply) => {
        services.auth.logout(request.cookies[SESSION_COOKIE]);
        reply.clearCookie(SESSION_COOKIE, { path: "/" });
        services.audit.record({
          actor: request.dashboardUser!.name,
          action: "auth.logout",
          targetType: "auth",
        });
        return { ok: true };
      });

      api.get("/sessions", async (request) => {
        const query = sessionListSchema.parse(request.query);
        return {
          items: services.repos.sessions.list({
            status: query.status as SessionStatus | undefined,
            projectId: query.projectId,
            agentId: query.agentId,
            query: query.q,
            limit: query.limit,
            offset: query.offset,
          }),
        };
      });

      api.post("/sessions", async (request, reply) => {
        const body = parseBody(createSessionSchema, request.body);
        const actor = actorFor(request);
        const session = await services.sessions.create({
          origin: "dashboard",
          creatorId: actor.id,
          projectId: body.projectId,
          agentId: body.agentId,
          title: body.title,
        });
        reply.code(201);
        return { session: services.repos.sessions.summaryById(session.id) };
      });

      api.get<{ Params: { id: string } }>("/sessions/:id", async (request) => {
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        const summary = services.repos.sessions.summaryById(session.id);
        return {
          session: summary,
          project: services.repos.projects.byId(session.projectId),
          agent: services.repos.agents.byId(session.agentId),
          jobs: services.repos.jobs.forSession(session.id).slice(0, 30),
          approvals: services.repos.approvals.pendingForSession(session.id),
          skills: services.repos.skills.forSession(session.id),
          memory: services.repos.memory.activeForProject(session.projectId).slice(0, 20),
        };
      });

      api.patch<{ Params: { id: string } }>("/sessions/:id", async (request) => {
        const body = parseBody(titleSchema, request.body);
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        services.sessions.setTitle(session, body.title, actor.id);
        return { session: services.repos.sessions.summaryById(session.id) };
      });

      api.get<{
        Params: { id: string };
        Querystring: { after?: string; limit?: string };
      }>("/sessions/:id/events", async (request) => {
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        const after = Math.max(0, Number.parseInt(request.query.after ?? "0", 10) || 0);
        const limit = Math.min(
          Math.max(Number.parseInt(request.query.limit ?? "200", 10) || 200, 1),
          1_000,
        );
        return {
          events: services.events.replay(session.id, after, limit),
          maxSeq: services.events.maxSeq(session.id),
        };
      });

      api.get<{ Params: { id: string } }>("/sessions/:id/stream", (request, reply) => {
        streamSession(services, request, reply);
      });

      api.post<{ Params: { id: string } }>("/sessions/:id/prompts", async (request, reply) => {
        const body = parseBody(promptSchema, request.body);
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        const result = await services.sessions.prompt(session, actor, body.text);
        reply.code(202);
        return { jobId: result.jobId, duplicate: result.duplicate };
      });

      api.post<{ Params: { id: string } }>("/sessions/:id/cancel", async (request) => {
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        await services.queue.cancel(session.id, actor.id, "cancel");
        return { ok: true };
      });

      api.post<{ Params: { id: string } }>("/sessions/:id/stop", async (request) => {
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        await services.queue.cancel(session.id, actor.id, "stop");
        return { ok: true };
      });

      api.get<{ Params: { id: string } }>("/sessions/:id/diff", async (request) => {
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        return services.workspace.diff(session);
      });

      api.get<{
        Params: { id: string };
        Querystring: { path?: string; limit?: string };
      }>("/sessions/:id/files", async (request) => {
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        const limit = Math.min(
          Math.max(Number.parseInt(request.query.limit ?? "500", 10) || 500, 1),
          2_000,
        );
        return {
          entries: await services.workspace.listFiles(session, request.query.path ?? "", limit),
        };
      });

      api.get<{
        Params: { id: string };
        Querystring: { path: string };
      }>("/sessions/:id/file", async (request) => {
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        if (!request.query.path) throw new HttpError(400, "path is required");
        return services.workspace.readWorkspaceFile(session, request.query.path);
      });

      api.post<{ Params: { id: string } }>("/sessions/:id/skills", async (request, reply) => {
        const body = parseBody(attachSkillSchema, request.body);
        const actor = actorFor(request);
        const session = services.sessions.getForActor(request.params.id, actor);
        services.skills.attach(session.id, body.skillId, actor.id);
        reply.code(201);
        return { skills: services.repos.skills.forSession(session.id) };
      });

      api.delete<{ Params: { id: string; skillId: string } }>(
        "/sessions/:id/skills/:skillId",
        async (request) => {
          const actor = actorFor(request);
          const session = services.sessions.getForActor(request.params.id, actor);
          services.skills.detach(session.id, request.params.skillId, actor.id);
          return { skills: services.repos.skills.forSession(session.id) };
        },
      );

      api.post<{ Params: { id: string } }>(
        "/sessions/:id/github/pull-requests",
        async (request, reply) => {
          const body = parseBody(prSchema, request.body);
          const actor = actorFor(request);
          const session = services.sessions.getForActor(request.params.id, actor);
          const approval = services.githubFlow.requestPullRequest(session, actor, {
            sessionId: session.id,
            ...body,
          });
          reply.code(202);
          return { approval };
        },
      );

      api.get("/approvals", async () => ({
        items: services.repos.approvals.listPending(),
      }));

      api.get<{ Params: { id: string } }>("/approvals/:id", async (request) => {
        const approval = services.repos.approvals.byId(request.params.id);
        if (!approval) throw new HttpError(404, "Approval not found");
        const actor = actorFor(request);
        services.sessions.getForActor(approval.sessionId, actor);
        return { approval };
      });

      api.post<{ Params: { id: string } }>("/approvals/:id/resolve", async (request) => {
        const body = parseBody(resolveSchema, request.body);
        const actor = actorFor(request);
        const result = await services.approvals.resolve(request.params.id, {
          optionId: body.optionId,
          actor,
        });
        return result;
      });

      api.get("/agents", async () => ({ items: services.repos.agents.list() }));

      api.post("/agents", async (request, reply) => {
        const body = parseBody(agentProfileSchema, request.body);
        const actor = actorFor(request);
        validateAgentDeployment(services, body);
        const existing = services.repos.agents.byId(body.id);
        if (existing) throw new HttpError(409, "An agent with that id already exists");
        const agent = services.repos.agents.create(body, new Date().toISOString());
        services.audit.record({
          actor: actor.id,
          action: "agent.created",
          targetType: "agent",
          targetId: agent.id,
        });
        reply.code(201);
        return { agent };
      });

      api.patch<{ Params: { id: string } }>("/agents/:id", async (request) => {
        const patch = parseBody(agentPatchSchema, request.body);
        const actor = actorFor(request);
        const current = services.repos.agents.byId(request.params.id);
        if (!current) throw new HttpError(404, "Agent not found");
        const candidate = agentProfileSchema.parse({
          ...toAgentProfile(current),
          ...patch,
          id: current.id,
        });
        validateAgentDeployment(services, candidate);
        const agent = services.repos.agents.update(current.id, candidate, new Date().toISOString());
        services.audit.record({
          actor: actor.id,
          action: "agent.updated",
          targetType: "agent",
          targetId: current.id,
        });
        return { agent };
      });

      api.delete<{ Params: { id: string } }>("/agents/:id", async (request) => {
        const actor = actorFor(request);
        const existing = services.repos.agents.byId(request.params.id);
        if (!existing) throw new HttpError(404, "Agent not found");
        try {
          services.repos.agents.remove(request.params.id);
        } catch {
          throw new HttpError(409, "Agent is referenced by existing sessions; disable it instead");
        }
        services.audit.record({
          actor: actor.id,
          action: "agent.deleted",
          targetType: "agent",
          targetId: request.params.id,
        });
        return { ok: true };
      });

      api.post<{ Params: { id: string } }>("/agents/:id/doctor", async (request) => {
        const report = await services.agents.doctor(request.params.id);
        return { report };
      });

      api.get("/projects", async () => ({ items: services.repos.projects.list(true) }));

      api.post("/projects", async (request, reply) => {
        const body = parseBody(projectSchema, request.body);
        validateProjectInput(services, body);
        if (services.repos.projects.bySlug(body.slug)) {
          throw new HttpError(409, "A project with that slug already exists");
        }
        const actor = actorFor(request);
        const project = services.repos.projects.create(
          { id: `prj_${body.slug}`, ...body },
          new Date().toISOString(),
        );
        services.audit.record({
          actor: actor.id,
          action: "project.created",
          targetType: "project",
          targetId: project.id,
        });
        reply.code(201);
        return { project };
      });

      api.patch<{ Params: { id: string } }>("/projects/:id", async (request) => {
        const body = parseBody(projectPatchSchema, request.body);
        const actor = actorFor(request);
        const current = services.repos.projects.byId(request.params.id);
        if (!current) throw new HttpError(404, "Project not found");
        const candidate = projectSchema.parse({
          name: body.name ?? current.name,
          slug: body.slug ?? current.slug,
          localPath: body.localPath ?? current.localPath,
          repository: body.repository ?? current.repository,
          defaultBranch: body.defaultBranch ?? current.defaultBranch,
          allowedChannels: body.allowedChannels ?? current.allowedChannels,
          allowedUsers: body.allowedUsers ?? current.allowedUsers,
        });
        const slugOwner = services.repos.projects.bySlug(candidate.slug);
        if (slugOwner && slugOwner.id !== current.id) {
          throw new HttpError(409, "A project with that slug already exists");
        }
        validateProjectInput(services, candidate);
        const project = services.repos.projects.update(
          current.id,
          { ...candidate, archived: body.archived },
          new Date().toISOString(),
        );
        services.audit.record({
          actor: actor.id,
          action: "project.updated",
          targetType: "project",
          targetId: current.id,
          detail: { archived: body.archived },
        });
        return { project };
      });

      api.get("/skills", async () => ({ items: services.skills.list() }));

      api.get<{ Params: { id: string } }>("/skills/:id", async (request) => ({
        skill: services.skills.get(request.params.id),
        versions: services.skills.versions(request.params.id),
      }));

      api.post("/skills", async (request, reply) => {
        const body = parseBody(skillCreateSchema, request.body);
        const actor = actorFor(request);
        const skill = services.skills.create(body, actor.id);
        reply.code(201);
        return { skill };
      });

      api.patch<{ Params: { id: string } }>("/skills/:id", async (request) => {
        const body = parseBody(skillPatchSchema, request.body);
        const actor = actorFor(request);
        const skill = services.skills.update(request.params.id, body, actor.id);
        return { skill };
      });

      api.post<{ Params: { id: string } }>("/skills/:id/enable", async (request) => {
        const actor = actorFor(request);
        const skill = services.skills.enable(request.params.id, actor.id);
        return { skill };
      });

      api.post<{ Params: { id: string } }>("/skills/:id/disable", async (request) => {
        const actor = actorFor(request);
        const skill = services.skills.disable(request.params.id, actor.id);
        return { skill };
      });

      api.get<{ Params: { id: string } }>("/skills/:id/versions", async (request) => {
        return { versions: services.skills.versions(request.params.id) };
      });

      api.get<{
        Params: { projectId: string };
        Querystring: { status?: string };
      }>("/projects/:projectId/memory", async (request) => {
        const status = ["proposed", "active", "deleted"].includes(request.query.status ?? "")
          ? (request.query.status as "proposed" | "active" | "deleted")
          : undefined;
        return {
          items: status
            ? services.repos.memory.list(request.params.projectId, status)
            : services.memory.list(request.params.projectId),
        };
      });

      api.post<{ Params: { projectId: string } }>(
        "/projects/:projectId/memory",
        async (request, reply) => {
          const body = parseBody(memoryCreateSchema, request.body);
          const actor = actorFor(request);
          const memory = services.memory.create({
            projectId: request.params.projectId,
            sessionId: body.sessionId,
            content: body.content,
            provenance: body.provenance ?? `dashboard:${actor.id}`,
            actor: actor.id,
            proposal: body.proposal,
          });
          reply.code(201);
          return { memory };
        },
      );

      api.patch<{ Params: { id: string } }>("/memory/:id", async (request) => {
        const body = parseBody(memoryPatchSchema, request.body);
        const actor = actorFor(request);
        return { memory: services.memory.update(request.params.id, body.content, actor.id) };
      });

      api.post<{ Params: { id: string } }>("/memory/:id/approve", async (request) => {
        const actor = actorFor(request);
        return { memory: services.memory.approve(request.params.id, actor.id) };
      });

      api.delete<{ Params: { id: string } }>("/memory/:id", async (request) => {
        const actor = actorFor(request);
        services.memory.remove(request.params.id, actor.id);
        return { ok: true };
      });

      api.get("/integrations/mcp", async () => ({ items: services.mcp.list() }));

      api.post("/integrations/mcp", async (request, reply) => {
        const actor = actorFor(request);
        const server = services.mcp.create(request.body, actor.id);
        reply.code(201);
        return { server };
      });

      api.patch<{ Params: { id: string } }>("/integrations/mcp/:id", async (request) => {
        const actor = actorFor(request);
        return { server: services.mcp.update(request.params.id, request.body, actor.id) };
      });

      api.delete<{ Params: { id: string } }>("/integrations/mcp/:id", async (request) => {
        const actor = actorFor(request);
        services.mcp.remove(request.params.id, actor.id);
        return { ok: true };
      });

      api.get("/integrations/github", async () => ({
        configured: services.github.configured,
        allowedRepos: services.config.github.allowedRepos,
        installationId: services.config.github.installationId,
      }));

      api.get("/integrations/github/repositories", async () => ({
        items: await services.github.listRepositories(),
      }));

      api.get("/integrations/github/issues", async (request) => {
        const query = githubQuerySchema.parse(request.query);
        return {
          items: await services.github.listIssues(query.repository, query.state ?? "open"),
        };
      });

      api.get("/integrations/github/pulls", async (request) => {
        const query = githubQuerySchema.parse(request.query);
        return {
          items: await services.github.listPullRequests(query.repository, query.state ?? "open"),
        };
      });

      api.get<{ Params: { number: string } }>(
        "/integrations/github/pulls/:number/diff",
        async (request) => {
          const query = githubQuerySchema.parse(request.query);
          const number = Number.parseInt(request.params.number, 10);
          if (!Number.isFinite(number) || number <= 0) throw new HttpError(400, "Invalid pull request number");
          return { diff: await services.github.getPullRequestDiff(query.repository, number) };
        },
      );

      api.get("/settings", async () => ({
        mode: services.config.mode,
        version: APP_VERSION,
        publicUrl: services.config.publicUrl,
        host: services.config.host,
        port: services.config.port,
        runner: {
          type: services.config.runner.type,
          image: services.config.runner.containerImage,
          network: services.config.runner.network,
        },
        limits: services.config.limits,
        slack: {
          configured: services.health.slackConfigured,
          allowedChannels: services.config.slack.allowedChannels,
          allowedUsers: services.config.slack.allowedUsers,
        },
        github: {
          configured: services.github.configured,
          allowedRepos: services.config.github.allowedRepos,
        },
        auth: {
          adminUser: services.config.auth.adminUser,
          sessionTtlHours: Math.round(services.config.auth.sessionTtlMs / 3_600_000),
        },
        acp: { protocolVersion: 1 },
      }));

      api.get<{ Querystring: { limit?: string; offset?: string } }>("/audit", async (request) => {
        const limit = Math.min(Number.parseInt(request.query.limit ?? "100", 10) || 100, 500);
        const offset = Math.max(Number.parseInt(request.query.offset ?? "0", 10) || 0, 0);
        return { items: services.repos.audit.list(limit, offset) };
      });
    },
    { prefix: "/api" },
  );
};

const toAgentProfile = (agent: {
  id: string;
  name: string;
  description?: string;
  executable: string;
  args: string[];
  env: string[];
  runner: "local" | "container";
  authentication?: string;
  enabled: boolean;
  preset: boolean;
}): AgentProfile => ({
  id: agent.id,
  name: agent.name,
  description: agent.description,
  executable: agent.executable,
  args: agent.args,
  env: agent.env,
  runner: agent.runner,
  authentication: agent.authentication,
  enabled: agent.enabled,
  preset: agent.preset,
});

const validateAgentDeployment = (services: Services, profile: AgentProfile): void => {
  if (services.config.mode === "server" && profile.runner !== "container") {
    throw new HttpError(400, "Server mode requires container-backed agents");
  }
  if (profile.runner === "container" && !services.config.runner.containerImage) {
    throw new HttpError(400, "Container agents require CONTAINER_IMAGE");
  }
};
