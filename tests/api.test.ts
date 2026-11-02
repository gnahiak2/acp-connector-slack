import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../packages/shared/src/index.js";
import { createServices, type Services } from "../apps/server/src/services.js";
import { buildApp } from "../apps/server/src/app.js";
import { makeGitRepo } from "./helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out");
};

describe("dashboard API", () => {
  let config: AppConfig;
  let services: Services;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let repo: string;
  let cookie: string;
  let csrf: string;

  beforeEach(async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "slackboard-api-"));
    repo = makeGitRepo();
    config = loadConfig({
      ADMIN_PASSWORD: "correct horse battery",
      DATA_DIR: dataDir,
      WORKSPACE_ROOT: join(dataDir, "workspaces"),
      SKILLS_DIR: resolve("skills"),
      LOG_LEVEL: "silent",
    });
    services = await createServices(config);
    app = await buildApp(services);
    const login = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "admin", password: "correct horse battery" },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json<{ csrfToken: string }>();
    csrf = body.csrfToken;
    const raw = login.headers["set-cookie"];
    const header = Array.isArray(raw) ? raw[0]! : String(raw);
    cookie = header.split(";")[0]!;
  });

  afterEach(async () => {
    await app.close().catch(() => undefined);
    await services.queue.shutdown().catch(() => undefined);
    await services.agents.disposeAll().catch(() => undefined);
    await services.approvals.shutdown().catch(() => undefined);
    try {
      services.db.close();
    } catch {
      // already closed
    }
    rmSync(config.dataDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  it("requires authentication, CSRF and a trusted origin for mutations", async () => {
    const anonymous = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(anonymous.statusCode).toBe(401);

    const noCsrf = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie },
      payload: { name: "x", slug: "x", localPath: repo },
    });
    expect(noCsrf.statusCode).toBe(403);

    const evilOrigin = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie, "x-slackboard-csrf": csrf, origin: "https://evil.example" },
      payload: { name: "x", slug: "x", localPath: repo },
    });
    expect(evilOrigin.statusCode).toBe(403);

    const settings = await app.inject({
      method: "GET",
      url: "/api/settings",
      headers: { cookie },
    });
    expect(settings.statusCode).toBe(200);
    expect(settings.json<{ auth: { adminUser: string } }>().auth.adminUser).toBe("admin");
    expect(JSON.stringify(settings.json())).not.toContain("correct horse battery");
  });

  it("drives a session end to end and replays events over SSE", async () => {
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      headers: { cookie, "x-slackboard-csrf": csrf },
      payload: {
        name: "API project",
        slug: "api-project",
        localPath: repo,
        defaultBranch: "main",
      },
    });
    expect(project.statusCode).toBe(201);

    const agent = await app.inject({
      method: "POST",
      url: "/api/agents",
      headers: { cookie, "x-slackboard-csrf": csrf },
      payload: {
        id: "fake",
        name: "Fake",
        executable: process.execPath,
        args: [fixture],
        env: [],
        runner: "local",
        enabled: true,
      },
    });
    expect(agent.statusCode).toBe(201);

    const session = await app.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { cookie, "x-slackboard-csrf": csrf },
      payload: { projectId: "prj_api-project", agentId: "fake", title: "API session" },
    });
    expect(session.statusCode).toBe(201);
    const sessionId = session.json<{ session: { id: string } }>().session.id;

    const prompt = await app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/prompts`,
      headers: { cookie, "x-slackboard-csrf": csrf },
      payload: { text: "Hello API" },
    });
    expect(prompt.statusCode).toBe(202);
    await waitFor(() => services.repos.sessions.byId(sessionId)?.status === "completed");

    const detail = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}`,
      headers: { cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json<{ session: { status: string } }>().session.status).toBe("completed");

    const events = await app.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/events?after=0&limit=100`,
      headers: { cookie },
    });
    expect(events.statusCode).toBe(200);
    const eventBody = events.json<{ events: Array<{ type: string }> }>();
    expect(eventBody.events.map((event) => event.type)).toContain("job.finished");

    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    const response = await fetch(
      `${address}/api/sessions/${sessionId}/stream?after=0`,
      { headers: { cookie }, signal: controller.signal },
    );
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    let streamed = "";
    for (let read = 0; read < 5 && !streamed.includes("event:"); read += 1) {
      const chunk = await reader.read();
      if (chunk.done) break;
      streamed += new TextDecoder().decode(chunk.value);
    }
    expect(streamed).toContain("event:");
    controller.abort();

    const unauthenticatedStream = await fetch(
      `${address}/api/sessions/${sessionId}/stream`,
    );
    expect(unauthenticatedStream.status).toBe(401);
  });

  it("rate limits repeated login failures", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: { username: "admin", password: "wrong password" },
      });
      statuses.push(response.statusCode);
    }
    expect(statuses).toContain(429);
    expect(statuses.filter((status) => status === 401).length).toBeGreaterThan(0);
  });
});
