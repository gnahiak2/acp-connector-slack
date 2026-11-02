import type { Database } from "./database.js";
import { AgentRepository } from "./agents.js";
import { ProjectRepository } from "./projects.js";
import { SessionRepository } from "./sessions.js";
import { JobRepository } from "./jobs.js";
import { EventRepository } from "./events.js";
import { ApprovalRepository } from "./approvals.js";
import { SkillRepository } from "./skills.js";
import { MemoryRepository } from "./memory.js";
import { McpRepository } from "./integrations.js";
import { AuthRepository } from "./auth.js";
import { AuditRepository } from "./audit.js";
import { SlackRepository } from "./slack.js";

export class Repositories {
  readonly agents: AgentRepository;
  readonly projects: ProjectRepository;
  readonly sessions: SessionRepository;
  readonly jobs: JobRepository;
  readonly events: EventRepository;
  readonly approvals: ApprovalRepository;
  readonly skills: SkillRepository;
  readonly memory: MemoryRepository;
  readonly mcp: McpRepository;
  readonly auth: AuthRepository;
  readonly audit: AuditRepository;
  readonly slack: SlackRepository;

  constructor(db: Database) {
    this.agents = new AgentRepository(db);
    this.projects = new ProjectRepository(db);
    this.sessions = new SessionRepository(db);
    this.jobs = new JobRepository(db);
    this.events = new EventRepository(db);
    this.approvals = new ApprovalRepository(db);
    this.skills = new SkillRepository(db);
    this.memory = new MemoryRepository(db);
    this.mcp = new McpRepository(db);
    this.auth = new AuthRepository(db);
    this.audit = new AuditRepository(db);
    this.slack = new SlackRepository(db);
  }
}
