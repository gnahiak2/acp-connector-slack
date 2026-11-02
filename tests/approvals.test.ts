import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../packages/shared/src/index.js";
import { Database } from "../apps/server/src/db/database.js";
import { Repositories } from "../apps/server/src/db/index.js";
import { EventBus, EventService } from "../apps/server/src/core/events.js";
import { AccessService } from "../apps/server/src/core/access.js";
import { AuditService } from "../apps/server/src/core/audit.js";
import {
  ApprovalConflictError,
  ApprovalForbiddenError,
  ApprovalService,
} from "../apps/server/src/core/approvals.js";

const now = (): string => new Date().toISOString();

let db: Database;
let repos: Repositories;
let config: AppConfig;
let approvals: ApprovalService;

const setup = (approvalTimeoutMs = 15_000): void => {
  db = new Database(":memory:");
  repos = new Repositories(db);
  config = loadConfig({
    ADMIN_PASSWORD: "correct horse battery",
    DATA_DIR: mkdtempSync(join(tmpdir(), "slackboard-approval-")),
    SLACK_ALLOWED_USERS: "U1",
    SLACK_ALLOWED_CHANNELS: "C1",
  });
  const bus = new EventBus();
  const events = new EventService(repos.events, bus, {
    maxEventBytes: config.limits.maxEventBytes,
    redactValues: config.redactValues,
  });
  const access = new AccessService(config, repos);
  const audit = new AuditService(repos.audit, config.redactValues);
  approvals = new ApprovalService(repos, events, access, audit, { timeoutMs: approvalTimeoutMs });
  repos.agents.create(
    {
      id: "fake",
      name: "Fake",
      executable: "/bin/echo",
      args: [],
      env: [],
      runner: "local",
      enabled: true,
      preset: false,
    },
    now(),
  );
  repos.projects.create(
    { id: "prj", name: "Project", slug: "project", localPath: "/tmp" },
    now(),
  );
  repos.sessions.create(
    {
      id: "ses",
      origin: "slack",
      teamId: "T1",
      channelId: "C1",
      threadTs: "1.1",
      projectId: "prj",
      agentId: "fake",
      creatorId: "U1",
      title: "Test session",
      workspacePath: "/tmp",
      accessPolicy: { userIds: ["U1"], channelId: "C1" },
    },
    now(),
  );
};

beforeEach(() => setup());

afterEach(async () => {
  await approvals.shutdown();
  db.close();
  rmSync(config.dataDir, { recursive: true, force: true });
});

const dashboard = { kind: "dashboard" as const, id: "admin", name: "admin", role: "admin" as const };
const slack = (id: string) => ({ kind: "slack" as const, id, teamId: "T1" });

describe("approval authorisation", () => {
  it("resolves exactly one ACP option and rejects a second resolution", async () => {
    const decision = approvals.requestAcpPermission({
      sessionId: "ses",
      toolCall: { toolCallId: "tc", title: "Write file", kind: "edit" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "deny", name: "Deny", kind: "reject_once" },
      ],
    });
    const pending = repos.approvals.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.options.map((option) => option.optionId)).toEqual(["allow", "deny"]);
    const result = await approvals.resolve(pending[0]!.id, { optionId: "allow", actor: dashboard });
    expect(result.approval.status).toBe("resolved");
    await expect(decision).resolves.toEqual({ outcome: "selected", optionId: "allow" });
    await expect(
      approvals.resolve(pending[0]!.id, { optionId: "deny", actor: dashboard }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });

  it("refuses an unauthorised Slack member and an option that was never offered", async () => {
    approvals.requestAcpPermission({
      sessionId: "ses",
      toolCall: { toolCallId: "tc", title: "Write file" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    const pending = repos.approvals.listPending()[0]!;
    await expect(
      approvals.resolve(pending.id, { optionId: "allow", actor: slack("U2") }),
    ).rejects.toBeInstanceOf(ApprovalForbiddenError);
    await expect(
      approvals.resolve(pending.id, { optionId: "other", actor: slack("U1") }),
    ).rejects.toBeInstanceOf(ApprovalConflictError);
  });

  it("expires pending approvals and cancels the agent decision", async () => {
    await approvals.shutdown();
    db.close();
    rmSync(config.dataDir, { recursive: true, force: true });
    setup(40);
    const decision = approvals.requestAcpPermission({
      sessionId: "ses",
      toolCall: { toolCallId: "tc", title: "Slow tool" },
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
    await expect(decision).resolves.toEqual({ outcome: "cancelled" });
    const pending = repos.approvals.listPending();
    expect(pending).toHaveLength(0);
    const expired = db
      .prepare("SELECT status FROM approvals")
      .all()
      .map((row) => row.status);
    expect(expired).toEqual(["expired"]);
  });

  it("runs a registered action only after an approval", async () => {
    let calls = 0;
    approvals.registerHandler("github_push", async () => {
      calls += 1;
      return { pullRequestUrl: "https://example.test/pr/1" };
    });
    const approval = approvals.requestGithubApproval({
      sessionId: "ses",
      requestedBy: "U1",
      title: "Create draft PR",
      details: { repository: "org/repo", head: "feature", base: "main" },
    });
    expect(calls).toBe(0);
    const result = await approvals.resolve(approval.id, { optionId: "approve", actor: dashboard });
    expect(calls).toBe(1);
    expect(result.action).toEqual({ pullRequestUrl: "https://example.test/pr/1" });
  });
});
