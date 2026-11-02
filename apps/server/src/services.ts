import { loadAgentsFile, validateAgentForDeployment, type AgentProfile, type AppConfig } from "@slackboard/shared";
import { GithubService } from "@slackboard/integrations";
import { Database } from "./db/database.js";
import { Repositories } from "./db/index.js";
import { EventBus, EventService } from "./core/events.js";
import { AccessService } from "./core/access.js";
import { AuditService } from "./core/audit.js";
import { AuthService } from "./core/auth.js";
import { WorkspaceManager } from "./core/workspace.js";
import { ApprovalService } from "./core/approvals.js";
import { AgentManager } from "./core/agent-manager.js";
import { JobQueue } from "./core/jobs.js";
import { SessionService } from "./core/session-service.js";
import { MemoryService } from "./core/memory-service.js";
import { SkillService } from "./core/skill-service.js";
import { McpService } from "./core/mcp-service.js";
import { GithubFlow } from "./core/github-flow.js";

export interface HealthState {
  slackConfigured: boolean;
  slackConnected: boolean;
  slackLastError?: string;
}

export interface Services {
  config: AppConfig;
  db: Database;
  repos: Repositories;
  events: EventService;
  bus: EventBus;
  access: AccessService;
  audit: AuditService;
  auth: AuthService;
  workspace: WorkspaceManager;
  approvals: ApprovalService;
  agents: AgentManager;
  queue: JobQueue;
  sessions: SessionService;
  memory: MemoryService;
  skills: SkillService;
  mcp: McpService;
  github: GithubService;
  githubFlow: GithubFlow;
  health: HealthState;
}

export const createServices = async (config: AppConfig): Promise<Services> => {
  const db = new Database(config.dbPath);
  const repos = new Repositories(db);
  const bus = new EventBus();
  const events = new EventService(repos.events, bus, {
    maxEventBytes: config.limits.maxEventBytes,
    redactValues: config.redactValues,
  });
  const access = new AccessService(config, repos);
  const audit = new AuditService(repos.audit, config.redactValues);
  const auth = new AuthService(config, repos.auth);
  const github = new GithubService(
    config.github.appId && config.github.privateKeyPath && config.github.installationId
      ? {
          appId: config.github.appId,
          privateKeyPath: config.github.privateKeyPath,
          installationId: config.github.installationId,
          allowedRepos: config.github.allowedRepos,
        }
      : undefined,
  );
  const workspace = new WorkspaceManager(config, repos, events, github);
  const approvals = new ApprovalService(repos, events, access, audit, {
    timeoutMs: config.limits.approvalTimeoutMs,
  });

  const queueRef: { current?: JobQueue } = {};
  const agents = new AgentManager(
    config,
    repos,
    events,
    approvals,
    workspace,
    audit,
    (sessionId, reason) => queueRef.current?.notifyAgentExit(sessionId, reason),
  );
  const queue = new JobQueue(config, repos, events, workspace, agents, approvals, audit);
  queueRef.current = queue;
  const sessions = new SessionService(config, repos, events, access, workspace, queue, audit);
  const memory = new MemoryService(repos, audit, config.redactValues);
  const skills = new SkillService(repos, audit, config.skillsRoot, config.limits.maxSkillBytes);
  const mcp = new McpService(repos, audit);
  const githubFlow = new GithubFlow(
    config,
    repos,
    events,
    workspace,
    approvals,
    access,
    github,
    audit,
  );
  githubFlow.register();

  const agentsFile: AgentProfile[] = loadAgentsFile(config.agentsConfigPath);
  for (const profile of agentsFile) validateAgentForDeployment(config, profile);
  repos.agents.seed(agentsFile, new Date().toISOString());
  for (const agent of repos.agents.list()) {
    if (!agent.enabled) continue;
    validateAgentForDeployment(config, {
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
  }
  await skills.seedBundled();
  await approvals.expireStale();
  auth.purgeExpired();
  memory.purgeExpired(config.limits.memoryRetentionDays);
  repos.slack.purgeDedupeBefore(new Date(Date.now() - 7 * 86_400_000).toISOString());
  await queue.recover();

  return {
    config,
    db,
    repos,
    events,
    bus,
    access,
    audit,
    auth,
    workspace,
    approvals,
    agents,
    queue,
    sessions,
    memory,
    skills,
    mcp,
    github,
    githubFlow,
    health: {
      slackConfigured: Boolean(config.slack.botToken && config.slack.appToken),
      slackConnected: false,
    },
  };
};
