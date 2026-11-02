import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig, type SessionRecord } from "../packages/shared/src/index.js";
import { createServices, type Services } from "../apps/server/src/services.js";
import { makeGitRepo } from "./helpers.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const skillsRoot = resolve("skills");

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
};

interface Harness {
  config: AppConfig;
  services: Services;
}

const tempDirs: string[] = [];

const setup = async (extraEnv: NodeJS.ProcessEnv = {}): Promise<Harness> => {
  const dataDir = mkdtempSync(join(tmpdir(), "slackboard-int-"));
  tempDirs.push(dataDir);
  const config = loadConfig({
    ADMIN_PASSWORD: "correct horse battery",
    DATA_DIR: dataDir,
    WORKSPACE_ROOT: join(dataDir, "workspaces"),
    SKILLS_DIR: skillsRoot,
    LOG_LEVEL: "silent",
    ...extraEnv,
  });
  const services = await createServices(config);
  return { config, services };
};

const cleanup = async (harness: Harness): Promise<void> => {
  await harness.services.queue.shutdown().catch(() => undefined);
  await harness.services.agents.disposeAll().catch(() => undefined);
  await harness.services.approvals.shutdown().catch(() => undefined);
  try {
    harness.services.db.close();
  } catch {
    // A restart test may already have closed this handle.
  }
  rmSync(harness.config.dataDir, { recursive: true, force: true });
};

const makeProjectAndAgent = async (
  harness: Harness,
  repo: string,
  env: string[] = [],
): Promise<{ session: SessionRecord }> => {
  const now = new Date().toISOString();
  harness.services.repos.agents.create(
    {
      id: "fake",
      name: "Fake agent",
      executable: process.execPath,
      args: [fixture],
      env,
      runner: "local",
      enabled: true,
      preset: false,
    },
    now,
  );
  harness.services.repos.projects.create(
    {
      id: "prj_test",
      name: "Test project",
      slug: "test-project",
      localPath: repo,
      defaultBranch: "main",
    },
    now,
  );
  const session = await harness.services.sessions.create({
    origin: "dashboard",
    creatorId: "admin",
    projectId: "prj_test",
    agentId: "fake",
    title: "Integration session",
  });
  return { session };
};

const dashboardActor = { kind: "dashboard" as const, id: "admin", name: "admin", role: "admin" as const };

describe("durable session orchestration", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await setup();
  });

  afterEach(async () => {
    await cleanup(harness);
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("runs a real ACP subprocess through the queue and persists ordered events", async () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    const { session } = await makeProjectAndAgent(harness, repo);
    await harness.services.sessions.prompt(session, dashboardActor, "Say hello");
    await waitFor(() => harness.services.repos.sessions.byId(session.id)?.status === "completed");
    const events = harness.services.events.replay(session.id, 0, 1_000);
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("session.created");
    expect(types).toContain("job.started");
    expect(types).toContain("agent.message.delta");
    expect(types).toContain("agent.tool_call");
    expect(types).toContain("agent.plan");
    expect(types).toContain("agent.commands");
    expect(types).toContain("agent.message.completed");
    expect(types.indexOf("agent.message.completed")).toBeLessThan(types.indexOf("job.finished"));
    expect(types.indexOf("agent.commands")).toBeLessThan(types.indexOf("job.finished"));
    expect(types).not.toContain("agent_thought_chunk");
    const payloadText = JSON.stringify(events);
    expect(payloadText).not.toContain("private reasoning must not be published");
    const deltas = events
      .filter((event) => event.type === "agent.message.delta")
      .map((event) => (event.payload as { text: string }).text)
      .join("");
    expect(deltas).toContain("Hello from the fake agent.");
    expect(deltas).toContain("Done.");
    const [job] = harness.services.repos.jobs.forSession(session.id);
    expect(job?.status).toBe("completed");
    expect(job?.stopReason).toBe("end_turn");
    const updated = harness.services.repos.sessions.byId(session.id)!;
    expect(updated.acpSessionId).toBe("fake-session-1");
    expect(readFileSync(join(updated.workspacePath, "README.md"), "utf8")).toContain("hello");
  });

  it("deduplicates repeated Slack deliveries without requeueing work", async () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    const { session } = await makeProjectAndAgent(harness, repo);
    const first = await harness.services.sessions.prompt(
      session,
      dashboardActor,
      "First prompt",
      "slack:T1:C1:123.456",
    );
    const second = await harness.services.sessions.prompt(
      session,
      dashboardActor,
      "First prompt",
      "slack:T1:C1:123.456",
    );
    expect(second.duplicate).toBe(true);
    expect(second.jobId).toBe(first.jobId);
    expect(harness.services.repos.jobs.forSession(session.id)).toHaveLength(1);
    expect(harness.services.repos.slack.claimEvent("event:T1:1", new Date().toISOString())).toBe(true);
    expect(harness.services.repos.slack.claimEvent("event:T1:1", new Date().toISOString())).toBe(false);
    await waitFor(() => harness.services.repos.sessions.byId(session.id)?.status === "completed");
  });

  it("serializes concurrent replies to one session", async () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    harness.services.repos.agents.create(
      {
        id: "hang-agent",
        name: "Hanging agent",
        executable: process.execPath,
        args: [fixture, "--hang"],
        env: [],
        runner: "local",
        enabled: true,
        preset: false,
      },
      new Date().toISOString(),
    );
    harness.services.repos.projects.create(
      {
        id: "prj_hang",
        name: "Hang project",
        slug: "hang-project",
        localPath: repo,
        defaultBranch: "main",
      },
      new Date().toISOString(),
    );
    const session = await harness.services.sessions.create({
      origin: "dashboard",
      creatorId: "admin",
      projectId: "prj_hang",
      agentId: "hang-agent",
      title: "Hanging session",
    });
    await harness.services.sessions.prompt(session, dashboardActor, "First reply");
    await harness.services.sessions.prompt(session, dashboardActor, "Second reply");
    await waitFor(() => {
      const jobs = harness.services.repos.jobs.forSession(session.id);
      return (
        jobs.some((job) => job.status === "queued") &&
        jobs.some((job) => job.status === "running")
      );
    });
    const jobs = harness.services.repos.jobs.forSession(session.id);
    expect(jobs.filter((job) => job.status === "running")).toHaveLength(1);
    expect(jobs.filter((job) => job.status === "queued")).toHaveLength(1);
    expect(harness.services.queue.isBusy(session.id)).toBe(true);
    await waitFor(() =>
      harness.services.events
        .replay(session.id, 0, 1_000)
        .some((event) => event.type === "session.context"),
    );
    await harness.services.queue.cancel(session.id, "admin", "stop");
    await waitFor(() =>
      harness.services.repos.jobs
        .forSession(session.id)
        .every((job) => job.status === "cancelled" || job.status === "interrupted"),
    );
  });

  it("marks uncertain in-flight work interrupted on restart and never replays it", async () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    const { session } = await makeProjectAndAgent(harness, repo);
    const now = new Date().toISOString();
    const job = harness.services.repos.jobs.enqueue(
      { id: "job_inflight", sessionId: session.id, prompt: "side effect", requestedBy: "admin" },
      now,
    );
    harness.services.repos.jobs.markStarted(job.id, now);
    harness.services.repos.sessions.updateStatus(session.id, "running", now);
    harness.services.db.close();

    const reopened = await createServices(harness.config);
    const restoredSession = reopened.repos.sessions.byId(session.id)!;
    const restoredJob = reopened.repos.jobs.byId(job.id)!;
    expect(restoredSession.status).toBe("interrupted");
    expect(restoredJob.status).toBe("interrupted");
    const events = reopened.events.replay(session.id, 0, 1_000);
    expect(events.some((event) => event.type === "job.finished")).toBe(true);
    expect(events.some((event) => event.type === "job.started" && event.jobId === job.id)).toBe(false);
    await reopened.queue.shutdown();
    reopened.db.close();
  });

  it("keeps memory scoped to its project", async () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    await makeProjectAndAgent(harness, repo);
    const now = new Date().toISOString();
    harness.services.repos.projects.create(
      { id: "prj_other", name: "Other", slug: "other", localPath: repo },
      now,
    );
    harness.services.memory.create({
      projectId: "prj_test",
      content: "Project one fact",
      provenance: "test",
      actor: "admin",
      proposal: false,
    });
    harness.services.memory.create({
      projectId: "prj_other",
      content: "Project two fact",
      provenance: "test",
      actor: "admin",
      proposal: false,
    });
    const one = harness.services.memory.list("prj_test");
    const two = harness.services.memory.list("prj_other");
    expect(one.map((item) => item.content)).toEqual(["Project one fact"]);
    expect(two.map((item) => item.content)).toEqual(["Project two fact"]);
  });

  it("uses a self-contained clone for container-backed agents", async () => {
    const repo = makeGitRepo();
    tempDirs.push(repo);
    harness.config.runner.containerImage = "example/agent:1";
    const now = new Date().toISOString();
    harness.services.repos.agents.create(
      {
        id: "container-agent",
        name: "Container agent",
        executable: "/agent",
        args: [],
        env: [],
        runner: "container",
        enabled: true,
        preset: false,
      },
      now,
    );
    harness.services.repos.projects.create(
      {
        id: "prj_clone",
        name: "Clone project",
        slug: "clone-project",
        localPath: repo,
        defaultBranch: "main",
      },
      now,
    );
    const session = await harness.services.sessions.create({
      origin: "dashboard",
      creatorId: "admin",
      projectId: "prj_clone",
      agentId: "container-agent",
      title: "Clone",
    });
    const workspace = await harness.services.workspace.ensure(
      session,
      harness.services.repos.projects.byId("prj_clone")!,
    );
    expect(statSync(join(workspace, ".git")).isDirectory()).toBe(true);
  });
});
