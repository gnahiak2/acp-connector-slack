import type { AppConfig, ProjectRecord, SessionRecord } from "@slackboard/shared";
import type { Repositories } from "../db/index.js";

export type Actor =
  | { kind: "dashboard"; id: string; name: string; role: "admin" }
  | { kind: "slack"; id: string; teamId?: string };

const wildcard = (list: string[]): boolean => list.includes("*");
const listed = (list: string[], value: string | undefined): boolean => {
  if (list.length === 0) return true;
  if (!value) return false;
  return wildcard(list) || list.includes(value);
};

export class AccessService {
  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
  ) {}

  slackUserAllowed(userId: string): boolean {
    return listed(this.config.slack.allowedUsers, userId);
  }

  slackChannelAllowed(channelId: string): boolean {
    return listed(this.config.slack.allowedChannels, channelId);
  }

  projectAllowed(project: ProjectRecord, actor: Actor): boolean {
    if (actor.kind === "dashboard") return true;
    if (project.allowedUsers.length > 0 && !listed(project.allowedUsers, actor.id)) return false;
    return true;
  }

  projectAllowedForChannel(project: ProjectRecord, channelId: string | undefined): boolean {
    if (project.allowedChannels.length === 0) return true;
    return wildcard(project.allowedChannels) || Boolean(channelId && project.allowedChannels.includes(channelId));
  }

  sessionAllowed(session: SessionRecord, actor: Actor): boolean {
    if (actor.kind === "dashboard") return true;
    if (!this.slackUserAllowed(actor.id)) return false;
    if (session.teamId && actor.teamId && session.teamId !== actor.teamId) return false;
    if (session.accessPolicy.channelId && session.channelId !== session.accessPolicy.channelId) {
      return false;
    }
    if (
      session.accessPolicy.userIds.length > 0 &&
      !session.accessPolicy.userIds.includes(actor.id)
    ) {
      return false;
    }
    const project = this.repos.projects.byId(session.projectId);
    if (!project) return false;
    if (!this.projectAllowedForChannel(project, session.channelId)) return false;
    if (project.allowedUsers.length > 0 && !listed(project.allowedUsers, actor.id)) return false;
    return true;
  }

  agentAllowed(session: SessionRecord): boolean {
    const agent = this.repos.agents.byId(session.agentId);
    return Boolean(agent?.enabled);
  }
}
