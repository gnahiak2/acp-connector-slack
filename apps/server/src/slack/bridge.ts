import type { WebClient } from "@slack/web-api";
import { App, type LogLevel } from "@slack/bolt";
import type {
  AgentRecord,
  ProjectRecord,
  PublicEvent,
  SessionRecord,
} from "@slackboard/shared";
import { preview } from "@slackboard/shared";
import type { Services } from "../services.js";
import type { Actor } from "../core/access.js";
import { SessionForbiddenError, SetupRequiredError } from "../core/session-service.js";
import { SlackStreamer, withSlackRetry } from "./stream.js";
import {
  approvalsListText,
  helpText,
  renderApprovalRequest,
  renderResolvedApproval,
  renderSessionStatus,
  renderToolProgress,
  type SlackBlock,
  type SlackMessage,
} from "./render.js";
import { escapeSlackText, truncateSlackText } from "./chunk.js";

interface SlackEventShape {
  type?: string;
  subtype?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel?: string;
  channel_type?: string;
  team?: string;
  event_id?: string;
  client_msg_id?: string;
  files?: unknown[];
}

interface CommandShape {
  team_id?: string;
  channel_id: string;
  user_id: string;
  text: string;
  trigger_id?: string;
  thread_ts?: string;
}

interface ApprovalActionBody {
  user?: { id?: string };
  team?: { id?: string } | null;
  channel?: { id?: string };
  message?: { ts?: string };
  container?: { message_ts?: string };
  actions?: Array<{ value?: string; action_ts?: string }>;
}

type ApprovalEvent = Extract<
  PublicEvent,
  { type: "approval.requested" | "approval.resolved" | "approval.expired" }
>;

interface SlackBridgeOptions {
  app?: App;
  client?: WebClient;
}

class PromptView {
  private readonly streamer: SlackStreamer;
  private readonly chain: Promise<void> = Promise.resolve();
  private toolTs?: string;
  private toolEntries = new Map<string, { title: string; status?: string }>();
  private failed = false;
  private sawDelta = false;
  private finished = false;
  private lastSeq = 0;
  private toolTimer?: NodeJS.Timeout;

  constructor(
    private readonly bridge: SlackBridge,
    private readonly services: Services,
    private readonly session: SessionRecord,
    private readonly jobId: string,
    private readonly agent: AgentRecord | undefined,
  ) {
    this.streamer = new SlackStreamer({
      client: bridge.client(),
      channel: session.channelId ?? "",
      threadTs: session.threadTs ?? "",
      chunkChars: services.config.limits.slackChunkChars,
      updateIntervalMs: services.config.limits.slackUpdateIntervalMs,
    });
  }

  handle(event: PublicEvent): void {
    if (event.jobId !== this.jobId || this.finished) return;
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    void this.queue(() => this.apply(event));
  }

  private queue(operation: () => Promise<void>): Promise<void> {
    const next = this.chain.then(operation).catch((error) => {
      void this.bridge.reportError(this.session, error);
    });
    return next;
  }

  private async apply(event: PublicEvent): Promise<void> {
    if (this.finished) return;
    switch (event.type) {
      case "job.started":
        await this.streamer.start(`${this.agent?.name ?? "Agent"} is working…`);
        return;
      case "agent.message.delta":
        this.sawDelta = true;
        this.streamer.append(event.payload.text);
        return;
      case "agent.message.completed":
        if (!this.sawDelta) this.streamer.append(event.payload.text);
        return;
      case "agent.tool_call":
        this.toolEntries.set(event.payload.toolCallId, {
          title: event.payload.title,
          status: event.payload.status,
        });
        this.scheduleToolUpdate();
        return;
      case "agent.tool_update": {
        const current = this.toolEntries.get(event.payload.toolCallId);
        this.toolEntries.set(event.payload.toolCallId, {
          title: event.payload.title ?? current?.title ?? event.payload.toolCallId,
          status: event.payload.status ?? current?.status,
        });
        this.scheduleToolUpdate();
        return;
      }
      case "session.notice":
        if (event.payload.level === "info") return;
        await this.bridge.postText(
          this.session,
          `${event.payload.level === "error" ? ":warning:" : ":information_source:"} ${escapeSlackText(event.payload.message)}`,
        );
        return;
      case "session.error":
        this.failed = true;
        await this.streamer.fail(event.payload.message);
        return;
      case "job.finished": {
        this.finished = true;
        if (!this.failed) {
          await this.streamer.finish();
          const status =
            event.payload.status === "completed"
              ? `Completed${event.payload.stopReason ? ` (${event.payload.stopReason})` : ""}`
              : `${event.payload.status}${event.payload.error ? `: ${event.payload.error}` : ""}`;
          await this.bridge.postContext(this.session, status);
        } else {
          this.streamer.stop();
        }
        this.bridge.views.delete(this.jobId);
        return;
      }
      default:
        return;
    }
  }

  private scheduleToolUpdate(): void {
    if (this.toolTimer) return;
    this.toolTimer = setTimeout(() => {
      this.toolTimer = undefined;
      if (this.finished) return;
      void this.queue(async () => {
        const message = this.renderTools();
        if (!message) return;
        if (!this.toolTs) {
          const ts = await this.bridge.postBlocks(this.session, message);
          this.toolTs = ts;
        } else {
          await this.bridge.updateBlocks(this.session, this.toolTs, message);
        }
      });
    }, 700);
    this.toolTimer.unref();
  }

  private renderTools(): SlackMessage | undefined {
    const entries = [...this.toolEntries.values()].slice(-6);
    if (entries.length === 0) return undefined;
    const blocks: SlackBlock[] = entries.map((entry) =>
      renderToolProgress(entry.title, entry.status).blocks[0]!,
    );
    return {
      text: `Tool progress: ${entries.map((entry) => entry.title).join(", ")}`,
      blocks,
    };
  }

  close(): void {
    if (this.toolTimer) clearTimeout(this.toolTimer);
    this.streamer.stop();
  }
}

export class SlackBridge {
  private app?: App;
  private webClient?: WebClient;
  private unsubscribe?: () => void;
  private started = false;
  private registered = false;
  private readonly approvalMessages = new Map<string, string>();
  readonly views = new Map<string, PromptView>();

  constructor(
    private readonly services: Services,
    private readonly options: SlackBridgeOptions = {},
  ) {
    this.app = options.app;
    this.webClient = options.client;
  }

  client(): WebClient {
    if (!this.webClient) {
      if (!this.services.config.slack.botToken) throw new Error("Slack is not configured");
      this.webClient = new App({
        token: this.services.config.slack.botToken,
        appToken: this.services.config.slack.appToken,
        socketMode: true,
      }).client;
    }
    return this.webClient;
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (!this.services.config.slack.botToken || !this.services.config.slack.appToken) {
      this.services.health.slackConfigured = false;
      return;
    }
    if (!this.app) {
      this.app = new App({
        token: this.services.config.slack.botToken,
        appToken: this.services.config.slack.appToken,
        socketMode: true,
        logLevel: (this.services.config.logLevel === "debug" ? "debug" : "warn") as LogLevel,
      });
      this.app.error(async (error) => {
        this.services.health.slackLastError = error.message;
        process.stderr.write(`[slack] ${error.message}\n`);
      });
    }
    this.webClient = this.app.client;
    if (!this.registered) {
      this.register();
      this.registered = true;
    }
    this.unsubscribe = this.services.events.subscribe((event) => this.onEvent(event));
    await this.app.start();
    this.started = true;
    this.services.health.slackConfigured = true;
    this.services.health.slackConnected = true;
    this.services.health.slackLastError = undefined;
  }

  async stop(): Promise<void> {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = undefined;
    for (const view of this.views.values()) view.close();
    this.views.clear();
    if (this.app && this.started) {
      await this.app.stop().catch(() => undefined);
    }
    this.started = false;
    this.services.health.slackConnected = false;
  }

  private register(): void {
    const app = this.app!;
    app.event("app_mention", async (args) => {
      await this.onMention(args.event as unknown as SlackEventShape, args.body, args.client);
    });
    app.message(async (args) => {
      await this.onMessage(args.message as unknown as SlackEventShape, args.body, args.client);
    });
    app.command("/slackboard", async (args) => {
      await args.ack();
      await this.onCommand(
        args.command as unknown as CommandShape,
        args.respond as unknown as (message: {
          response_type?: "ephemeral" | "in_channel";
          text?: string;
          blocks?: SlackBlock[];
        }) => Promise<unknown>,
        args.client,
      );
    });
    app.action("slackboard_approval", async (args) => {
      await args.ack();
      await this.onApprovalAction(args.body as unknown as ApprovalActionBody, args.client);
    });
  }

  private async onMention(
    event: SlackEventShape,
    body: { team_id?: string; team?: { id?: string } },
    client: WebClient,
  ): Promise<void> {
    const teamId = body.team_id ?? body.team?.id ?? event.team;
    if (!this.validEvent(event, teamId, false)) return;
    const channelId = event.channel!;
    const eventTs = event.ts!;
    const threadTs = event.thread_ts ?? eventTs;
    const userId = event.user!;
    const key = `event:${teamId}:${event.event_id ?? `${channelId}:${eventTs}`}`;
    if (!this.services.repos.slack.claimEvent(key, new Date().toISOString())) return;
    const actor: Actor = { kind: "slack", id: userId, teamId };
    try {
      let session = this.services.sessions.findByThread(teamId!, channelId, threadTs);
      if (!session) {
        session = await this.services.sessions.createSlackSession({
          teamId: teamId!,
          channelId,
          threadTs,
          creatorId: userId,
          title: this.sessionTitle(event.text),
        });
      }
      if (!this.services.access.sessionAllowed(session, actor)) {
        await this.postText(session, ":no_entry: You are not authorised for this session.");
        return;
      }
      const text = this.cleanText(event.text);
      if (!text) {
        await this.postText(session, helpText());
        return;
      }
      await this.enqueue(session, actor, text, eventTs);
    } catch (error) {
      await this.handleRoutingError(channelId, threadTs, error, client);
    }
  }

  private async onMessage(
    message: SlackEventShape,
    body: { team_id?: string; team?: { id?: string } },
    client: WebClient,
  ): Promise<void> {
    const teamId = body.team_id ?? body.team?.id ?? message.team;
    if (!this.validEvent(message, teamId, true)) return;
    if (!message.user || !message.channel || !message.ts) return;
    const key = `event:${teamId}:${message.event_id ?? `${message.channel}:${message.ts}`}`;
    if (!this.services.repos.slack.claimEvent(key, new Date().toISOString())) return;
    const actor: Actor = { kind: "slack", id: message.user, teamId };
    const isDm = message.channel_type === "im" || message.channel.startsWith("D");
    try {
      let session: SessionRecord | undefined;
      if (isDm) {
        session =
          this.services.sessions.findByThread(teamId!, message.channel, message.thread_ts ?? message.ts) ??
          (message.thread_ts
            ? undefined
            : this.services.sessions.latestForChannel(message.channel));
        if (!session) {
          session = await this.services.sessions.createSlackSession({
            teamId: teamId!,
            channelId: message.channel,
            threadTs: message.thread_ts ?? message.ts,
            creatorId: message.user,
            title: this.sessionTitle(message.text),
          });
        }
      } else if (message.thread_ts) {
        session = this.services.sessions.findByThread(teamId!, message.channel, message.thread_ts);
      }
      if (!session) return;
      if (!this.services.access.sessionAllowed(session, actor)) return;
      const text = this.cleanText(message.text);
      if (!text) return;
      await this.enqueue(session, actor, text, message.ts);
    } catch (error) {
      await this.reportError(undefined, error);
      if (isDm) {
        await client.chat
          .postMessage({
            channel: message.channel,
            thread_ts: message.thread_ts ?? message.ts,
            text: ":warning: Slackboard could not process that message.",
          })
          .catch(() => undefined);
      }
    }
  }

  private async enqueue(
    session: SessionRecord,
    actor: Actor,
    text: string,
    eventTs: string,
  ): Promise<void> {
    const { jobId, duplicate } = await this.services.sessions.prompt(
      session,
      actor,
      text,
      `slack:${session.teamId}:${session.channelId}:${eventTs}`,
    );
    if (duplicate) return;
    const agent = this.services.repos.agents.byId(session.agentId);
    const view = new PromptView(this, this.services, session, jobId, agent);
    this.views.set(jobId, view);
    for (const event of this.services.repos.events.forJob(jobId)) view.handle(event);
  }

  private async onCommand(
    command: CommandShape,
    respond: (message: {
      response_type?: "ephemeral" | "in_channel";
      text?: string;
      blocks?: SlackBlock[];
    }) => Promise<unknown>,
    client: WebClient,
  ): Promise<void> {
    const teamId = command.team_id ?? "";
    const key = `command:${teamId}:${command.trigger_id ?? `${command.user_id}:${Date.now()}`}`;
    if (!this.services.repos.slack.claimEvent(key, new Date().toISOString())) return;
    const isDm = command.channel_id.startsWith("D");
    if (!this.services.access.slackUserAllowed(command.user_id)) {
      await respond({ response_type: "ephemeral", text: "You are not authorised to use Slackboard." });
      return;
    }
    if (!isDm && !this.services.access.slackChannelAllowed(command.channel_id)) {
      await respond({ response_type: "ephemeral", text: "Slackboard is not enabled in this channel." });
      return;
    }
    const actor: Actor = { kind: "slack", id: command.user_id, teamId };
    const [rawSub = "help", ...rest] = command.text.trim().split(/\s+/);
    const sub = rawSub.toLowerCase();
    try {
      if (sub === "help") {
        await respond({ response_type: "ephemeral", text: helpText() });
        return;
      }
      if (sub === "agents") {
        const agents = this.services.repos.agents.list(false);
        await respond({
          response_type: "ephemeral",
          text:
            agents.length === 0
              ? "No agents are configured. Add one in the dashboard."
              : agents
                  .map((agent) => `• \`${agent.id}\` — ${agent.name} (${agent.runner})`)
                  .join("\n"),
        });
        return;
      }
      if (sub === "projects") {
        const projects = this.services.repos.projects.list();
        await respond({
          response_type: "ephemeral",
          text:
            projects.length === 0
              ? "No projects are configured."
              : projects
                  .map((project) => `• \`${project.slug}\` — ${project.name}`)
                  .join("\n"),
        });
        return;
      }
      if (sub === "status" || sub === "approvals" || sub === "stop") {
        const session = this.resolveCommandSession(command, rest[0]);
        if (!session) {
          await respond({ response_type: "ephemeral", text: "No session found. Use `/slackboard start`." });
          return;
        }
        if (!this.services.access.sessionAllowed(session, actor)) {
          await respond({ response_type: "ephemeral", text: "You are not authorised for this session." });
          return;
        }
        if (sub === "status") {
          const status = renderSessionStatus(
            session,
            this.services.repos.projects.byId(session.projectId),
            this.services.repos.agents.byId(session.agentId),
            this.services.repos.approvals.pendingForSession(session.id).length,
          );
          await respond({ response_type: "ephemeral", text: status.text, blocks: status.blocks as any });
          return;
        }
        if (sub === "approvals") {
          await respond({
            response_type: "ephemeral",
            text: approvalsListText(this.services.repos.approvals.pendingForSession(session.id)),
          });
          return;
        }
        await this.services.queue.cancel(session.id, actor.id, "stop");
        await respond({ response_type: "ephemeral", text: `Stopping session \`${session.id}\`.` });
        return;
      }
      if (sub === "start") {
        if (!isDm && !this.services.access.slackChannelAllowed(command.channel_id)) {
          await respond({ response_type: "ephemeral", text: "This channel is not allowed." });
          return;
        }
        const agent = this.resolveAgent(rest[0]);
        const project = this.resolveProject(rest[1]);
        if (!agent) {
          await respond({ response_type: "ephemeral", text: "No enabled agent is available." });
          return;
        }
        if (!project) {
          await respond({ response_type: "ephemeral", text: "No project is available." });
          return;
        }
        this.services.sessions.setChannelDefaults(command.channel_id, {
          agentId: agent.id,
          projectId: project.id,
        });
        const posted = await withSlackRetry(() =>
          client.chat.postMessage({
            channel: command.channel_id,
            text: `Slackboard session ready with *${agent.name}* on *${project.name}*. Reply in this thread to begin.`,
          }),
        );
        if (!posted.ts) throw new Error("Slack did not return a thread timestamp");
        const session = await this.services.sessions.createSlackSession({
          teamId,
          channelId: command.channel_id,
          threadTs: posted.ts,
          creatorId: command.user_id,
          title: `${project.name} session`,
          agentId: agent.id,
          projectId: project.id,
        });
        await respond({
          response_type: "ephemeral",
          text: `Session \`${session.id}\` created. Continue in the new thread.`,
        });
        return;
      }
      if (sub === "skill") {
        const action = (rest[0] ?? "list").toLowerCase();
        const session = this.resolveCommandSession(command);
        if (!session) {
          await respond({ response_type: "ephemeral", text: "No session found. Use `/slackboard start`." });
          return;
        }
        if (!this.services.access.sessionAllowed(session, actor)) {
          await respond({ response_type: "ephemeral", text: "You are not authorised for this session." });
          return;
        }
        if (action === "list") {
          const attached = new Set(this.services.repos.skills.forSession(session.id).map((skill) => skill.id));
          const skills = this.services.repos.skills.enabled();
          await respond({
            response_type: "ephemeral",
            text:
              skills.length === 0
                ? "No skills are enabled."
                : skills
                    .map(
                      (skill) =>
                        `• ${attached.has(skill.id) ? ":white_check_mark:" : "•"} \`${skill.slug}\` v${skill.version} — ${skill.description}`,
                    )
                    .join("\n"),
          });
          return;
        }
        const slug = rest[1];
        if (!slug) {
          await respond({ response_type: "ephemeral", text: "Usage: `/slackboard skill use <slug>`." });
          return;
        }
        const skill = this.services.skills.withSlug(slug);
        if (!skill) {
          await respond({ response_type: "ephemeral", text: "Skill not found." });
          return;
        }
        if (action === "use") {
          this.services.skills.attach(session.id, skill.id, actor.id);
          await respond({ response_type: "ephemeral", text: `Attached skill \`${skill.slug}\`.` });
        } else if (action === "off") {
          this.services.skills.detach(session.id, skill.id, actor.id);
          await respond({ response_type: "ephemeral", text: `Detached skill \`${skill.slug}\`.` });
        } else {
          await respond({ response_type: "ephemeral", text: "Usage: `/slackboard skill [list|use|off]`." });
        }
        return;
      }
      if (sub === "memory") {
        const action = (rest[0] ?? "list").toLowerCase();
        const session = this.resolveCommandSession(command);
        if (!session) {
          await respond({ response_type: "ephemeral", text: "No session found. Use `/slackboard start`." });
          return;
        }
        if (!this.services.access.sessionAllowed(session, actor)) {
          await respond({ response_type: "ephemeral", text: "You are not authorised for this session." });
          return;
        }
        if (action === "list") {
          const memories = this.services.memory.list(session.projectId);
          await respond({
            response_type: "ephemeral",
            text:
              memories.length === 0
                ? "No project memory."
                : memories
                    .map(
                      (memory) =>
                        `• \`${memory.id}\` [${memory.status}] ${truncateSlackText(escapeSlackText(memory.content), 300)}`,
                    )
                    .join("\n"),
          });
          return;
        }
        if (action === "save") {
          const content = rest.slice(1).join(" ").trim();
          if (!content) {
            await respond({ response_type: "ephemeral", text: "Usage: `/slackboard memory save <text>`." });
            return;
          }
          const memory = this.services.memory.create({
            projectId: session.projectId,
            sessionId: session.id,
            content,
            provenance: `slack:${actor.id}:${session.channelId ?? "dm"}`,
            actor: actor.id,
            proposal: false,
          });
          await respond({
            response_type: "ephemeral",
            text: `Saved memory \`${memory.id}\` for project \`${session.projectId}\`.`,
          });
          return;
        }
        await respond({ response_type: "ephemeral", text: "Usage: `/slackboard memory [list|save]`." });
        return;
      }
      if (sub === "commands") {
        const session = this.resolveCommandSession(command);
        if (!session) {
          await respond({ response_type: "ephemeral", text: "No session found. Use `/slackboard start`." });
          return;
        }
        if (!this.services.access.sessionAllowed(session, actor)) {
          await respond({ response_type: "ephemeral", text: "You are not authorised for this session." });
          return;
        }
        const latest = this.services.repos.events
          .latest(session.id, 200)
          .reverse()
          .find((event) => event.type === "agent.commands");
        const commands =
          latest && latest.type === "agent.commands" ? latest.payload.commands : [];
        await respond({
          response_type: "ephemeral",
          text:
            commands.length === 0
              ? "The selected agent has not advertised commands. This is separate from Slackboard's `/slackboard` commands."
              : `Agent-provided commands (sent to the agent, not Slackboard):\n${commands
                  .map((item) => `• \`${item.name}\` — ${item.description}`)
                  .join("\n")}`,
        });
        return;
      }
      if (sub === "doctor") {
        const agent = this.resolveAgent(rest[0]) ?? this.services.sessions.defaultAgent();
        if (!agent) {
          await respond({ response_type: "ephemeral", text: "No agent is configured." });
          return;
        }
        await respond({ response_type: "ephemeral", text: `Running connection doctor for \`${agent.id}\`…` });
        const report = await this.services.agents.doctor(agent.id);
        await respond({
          response_type: "ephemeral",
          text: truncateSlackText(
            [
              `Doctor: ${report.ok ? "ok" : "failed"} for ${report.executable} ${report.args.join(" ")}`,
              report.protocolVersion ? `Protocol: ${report.protocolVersion}` : "",
              report.agentInfo ? `Agent: ${report.agentInfo.name} ${report.agentInfo.version}` : "",
              report.authMethods.length > 0
                ? `Auth methods: ${report.authMethods.map((method) => `${method.name} (${method.type})`).join(", ")}`
                : "Auth methods: none advertised",
              report.unsupported.length > 0 ? `Unsupported: ${report.unsupported.join(", ")}` : "",
              report.error ? `Error: ${report.error}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
            3_000,
          ),
        });
        return;
      }
      await respond({ response_type: "ephemeral", text: helpText() });
    } catch (error) {
      await respond({
        response_type: "ephemeral",
        text: `:warning: ${truncateSlackText(error instanceof Error ? error.message : String(error), 1_000)}`,
      });
    }
  }

  private async onApprovalAction(
    body: ApprovalActionBody,
    client: WebClient,
  ): Promise<void> {
    const userId = body.user?.id;
    const teamId = body.team?.id ?? "";
    const channelId = body.channel?.id;
    const messageTs = body.message?.ts ?? body.container?.message_ts;
    if (!userId || !channelId || !messageTs) return;
    if (!this.services.access.slackUserAllowed(userId)) {
      await client.chat
        .postEphemeral({ channel: channelId, user: userId, text: "You are not authorised." })
        .catch(() => undefined);
      return;
    }
    const raw = body.actions?.[0]?.value;
    if (!raw) return;
    let parsed: { a?: string; o?: string };
    try {
      parsed = JSON.parse(raw) as { a?: string; o?: string };
    } catch {
      return;
    }
    if (!parsed.a || !parsed.o) return;
    const actionTs = body.actions?.[0]?.action_ts ?? "";
    const key = `action:${teamId}:${userId}:${parsed.a}:${actionTs}`;
    if (!this.services.repos.slack.claimEvent(key, new Date().toISOString())) return;
    const approval = this.services.repos.approvals.byId(parsed.a);
    if (!approval) {
      await client.chat
        .update({ channel: channelId, ts: messageTs, text: "Approval no longer exists." })
        .catch(() => undefined);
      return;
    }
    const session = this.services.repos.sessions.byId(approval.sessionId);
    if (
      !session ||
      (session.channelId && session.channelId !== channelId) ||
      (session.teamId && teamId && session.teamId !== teamId)
    ) {
      await client.chat
        .postEphemeral({ channel: channelId, user: userId, text: "Approval does not belong to this channel." })
        .catch(() => undefined);
      return;
    }
    const actor: Actor = { kind: "slack", id: userId, teamId };
    if (!this.services.access.sessionAllowed(session, actor)) {
      await client.chat
        .postEphemeral({ channel: channelId, user: userId, text: "You are not authorised for this session." })
        .catch(() => undefined);
      return;
    }
    try {
      const result = await this.services.approvals.resolve(approval.id, {
        optionId: parsed.o,
        actor,
      });
      const option = result.approval.options.find((item) => item.optionId === parsed.o);
      const summary = result.error
        ? `Approved by <@${userId}> (${option?.name ?? parsed.o}), but the action failed: ${result.error}`
        : `Resolved by <@${userId}>: ${option?.name ?? parsed.o}`;
      const message = renderResolvedApproval(result.approval, summary);
      await withSlackRetry(() =>
        client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: message.text,
          blocks: message.blocks as any,
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await withSlackRetry(() =>
        client.chat.update({
          channel: channelId,
          ts: messageTs,
          text: `Approval could not be applied: ${message}`,
        }),
      );
    }
  }

  private onEvent(event: PublicEvent): void {
    if (
      event.type === "approval.requested" ||
      event.type === "approval.resolved" ||
      event.type === "approval.expired"
    ) {
      void this.handleApprovalEvent(event as ApprovalEvent);
    }
    if (event.type === "github.approval.requested") {
      void this.postApprovalMessage(event.payload.approvalId);
    }
    if (event.jobId) this.views.get(event.jobId)?.handle(event);
  }

  private async postApprovalMessage(approvalId: string): Promise<void> {
    const approval = this.services.repos.approvals.byId(approvalId);
    if (!approval) return;
    const session = this.services.repos.sessions.byId(approval.sessionId);
    if (!session?.channelId || !session.threadTs) return;
    if (approval.status !== "pending") {
      await this.postBlocks(
        session,
        renderResolvedApproval(approval, `Approval is already ${approval.status}.`),
      );
      return;
    }
    const message = renderApprovalRequest(approval);
    const ts = await this.postBlocks(session, message);
    if (ts) this.approvalMessages.set(approval.id, ts);
  }

  private async handleApprovalEvent(event: ApprovalEvent): Promise<void> {
    const session = this.services.repos.sessions.byId(event.sessionId);
    if (!session?.channelId || !session.threadTs) return;
    if (event.type === "approval.requested") {
      await this.postApprovalMessage(event.payload.approvalId);
      return;
    }
    const approval = this.services.repos.approvals.byId(event.payload.approvalId);
    if (!approval) return;
    const ts = this.approvalMessages.get(approval.id);
    if (!ts) return;
    const summary =
      event.type === "approval.expired"
        ? "Expired without a decision."
        : event.payload.outcome === "cancelled"
          ? "Cancelled."
          : `Resolved by ${
              event.payload.resolvedBy ? `<@${event.payload.resolvedBy}>` : "a member"
            }: ${
              approval.options.find((option) => option.optionId === event.payload.optionId)?.name ??
              event.payload.optionId ??
              ""
            }`;
    const message = renderResolvedApproval(approval, summary);
    await this.updateBlocks(session, ts, message);
    this.approvalMessages.delete(approval.id);
  }

  private validEvent(
    event: SlackEventShape,
    teamId: string | undefined,
    allowDm: boolean,
  ): boolean {
    if (!teamId || !event.channel || !event.ts) return false;
    if (event.bot_id || event.subtype) return false;
    if (!event.user) return false;
    if (!this.services.access.slackUserAllowed(event.user)) return false;
    const isDm = event.channel.startsWith("D") || event.channel_type === "im";
    if (isDm && !allowDm) return false;
    if (!isDm && !this.services.access.slackChannelAllowed(event.channel)) return false;
    return true;
  }

  private cleanText(text: string | undefined): string {
    return (text ?? "")
      .replace(/<@[A-Z0-9]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  private sessionTitle(text: string | undefined): string {
    const cleaned = this.cleanText(text);
    return cleaned ? preview(cleaned, 80) : `Slack session ${new Date().toISOString().slice(0, 16)}`;
  }

  private resolveCommandSession(
    command: { channel_id: string; team_id?: string; thread_ts?: string },
    explicitId?: string,
  ): SessionRecord | undefined {
    if (explicitId) return this.services.sessions.get(explicitId);
    if (command.thread_ts && command.team_id) {
      const byThread = this.services.sessions.findByThread(
        command.team_id,
        command.channel_id,
        command.thread_ts,
      );
      if (byThread) return byThread;
    }
    return this.services.sessions.latestForChannel(command.channel_id);
  }

  private resolveAgent(value: string | undefined): AgentRecord | undefined {
    if (!value) return this.services.repos.agents.list(false)[0];
    return (
      this.services.repos.agents.byId(value) ??
      this.services.repos.agents.list(false).find((agent) => agent.id === value)
    );
  }

  private resolveProject(value: string | undefined): ProjectRecord | undefined {
    if (!value) return this.services.repos.projects.list()[0];
    return (
      this.services.repos.projects.byId(value) ??
      this.services.repos.projects.bySlug(value)
    );
  }

  async postText(session: SessionRecord, text: string): Promise<void> {
    if (!session.channelId || !session.threadTs) return;
    await withSlackRetry(() =>
      this.client().chat.postMessage({
        channel: session.channelId!,
        thread_ts: session.threadTs!,
        text,
        mrkdwn: true,
      }),
    ).catch(() => undefined);
  }

  async postContext(session: SessionRecord, text: string): Promise<void> {
    if (!session.channelId || !session.threadTs) return;
    await withSlackRetry(() =>
      this.client().chat.postMessage({
        channel: session.channelId!,
        thread_ts: session.threadTs!,
        text: `_${escapeSlackText(text)}_`,
        mrkdwn: true,
      }),
    ).catch(() => undefined);
  }

  async postBlocks(session: SessionRecord, message: SlackMessage): Promise<string | undefined> {
    if (!session.channelId || !session.threadTs) return undefined;
    const response = await withSlackRetry(() =>
      this.client().chat.postMessage({
        channel: session.channelId!,
        thread_ts: session.threadTs!,
        text: message.text,
        blocks: message.blocks as any,
        mrkdwn: true,
      }),
    ).catch(() => undefined);
    return response?.ts;
  }

  async updateBlocks(
    session: SessionRecord,
    ts: string,
    message: SlackMessage,
  ): Promise<void> {
    if (!session.channelId) return;
    await withSlackRetry(() =>
      this.client().chat.update({
        channel: session.channelId!,
        ts,
        text: message.text,
        blocks: message.blocks as any,
      }),
    ).catch(() => undefined);
  }

  async reportError(session: SessionRecord | undefined, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    this.services.health.slackLastError = message;
    if (session) await this.postText(session, `:warning: ${escapeSlackText(message)}`);
  }

  private async handleRoutingError(
    channelId: string,
    threadTs: string,
    error: unknown,
    client: WebClient,
  ): Promise<void> {
    const message =
      error instanceof SetupRequiredError || error instanceof SessionForbiddenError
        ? error.message
        : "Slackboard could not start a session. Check the dashboard for configuration.";
    await client.chat
      .postMessage({ channel: channelId, thread_ts: threadTs, text: `:warning: ${message}` })
      .catch(() => undefined);
  }
}
