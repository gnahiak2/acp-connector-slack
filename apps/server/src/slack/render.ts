import type { ApprovalRecord, SessionRecord, ProjectRecord, AgentRecord } from "@slackboard/shared";
import { escapeSlackText, truncateSlackText } from "./chunk.js";

export type SlackBlock = Record<string, unknown>;

export interface SlackMessage {
  text: string;
  blocks: SlackBlock[];
}

const optionStyle = (kind: string): "primary" | "danger" | undefined => {
  if (kind.startsWith("allow")) return "primary";
  if (kind.startsWith("reject")) return "danger";
  return undefined;
};

export const renderApprovalRequest = (approval: ApprovalRecord): SlackMessage => {
  const preview =
    typeof approval.details.contentPreview === "string"
      ? truncateSlackText(approval.details.contentPreview, 900)
      : "";
  const repository =
    typeof approval.details.repository === "string" ? approval.details.repository : "";
  const head = typeof approval.details.head === "string" ? approval.details.head : "";
  const base = typeof approval.details.base === "string" ? approval.details.base : "";
  const target = repository
    ? `\nRepository: \`${escapeSlackText(repository)}\`${head && base ? `\nBranch: \`${escapeSlackText(head)}\` → \`${escapeSlackText(base)}\`` : ""}`
    : "";
  const blocks: SlackBlock[] = [
    {
      type: "header",
      text: { type: "plain_text", text: "Approval required", emoji: false },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeSlackText(approval.title)}*${
          approval.toolCallId
            ? `\nTool call: \`${escapeSlackText(approval.toolCallId)}\``
            : ""
        }${target}${preview ? `\n\n${escapeSlackText(preview)}` : ""}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Session \`${approval.sessionId}\` · expires ${approval.expiresAt}`,
        },
      ],
    },
  ];
  const options = approval.options.slice(0, 40);
  for (let index = 0; index < options.length; index += 5) {
    blocks.push({
      type: "actions",
      block_id: `approval_actions_${index / 5}`,
      elements: options.slice(index, index + 5).map((option, offset) => ({
        type: "button",
        action_id: "slackboard_approval",
        text: {
          type: "plain_text",
          text: truncateSlackText(option.name, 70),
          emoji: false,
        },
        value: JSON.stringify({ a: approval.id, o: option.optionId }),
        style: optionStyle(option.kind),
        ...(index + offset === 0 ? {} : {}),
      })),
    });
  }
  if (approval.options.length > options.length) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `${approval.options.length - options.length} additional options are available in the dashboard.`,
        },
      ],
    });
  }
  return {
    text: `Approval required: ${approval.title}`,
    blocks,
  };
};

export const renderResolvedApproval = (
  approval: ApprovalRecord,
  summary: string,
): SlackMessage => ({
  text: `Approval resolved: ${approval.title}`,
  blocks: [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeSlackText(approval.title)}*\n${escapeSlackText(summary)}`,
      },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Approval \`${approval.id}\`` }],
    },
  ],
});

export const renderSessionStatus = (
  session: SessionRecord,
  project: ProjectRecord | undefined,
  agent: AgentRecord | undefined,
  pendingApprovals: number,
): SlackMessage => {
  const blocks: SlackBlock[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${escapeSlackText(session.title)}*\nStatus: *${session.status}*\nAgent: ${escapeSlackText(agent?.name ?? session.agentId)}\nProject: ${escapeSlackText(project?.name ?? session.projectId)}`,
      },
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Session \`${session.id}\` · ${session.origin} · pending approvals: ${pendingApprovals}`,
        },
      ],
    },
  ];
  if (session.acpSessionId) {
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: `Agent session \`${session.acpSessionId}\`` }],
    });
  }
  return {
    text: `Session ${session.id}: ${session.status}`,
    blocks,
  };
};

export const renderToolProgress = (title: string, status: string | undefined): SlackMessage => ({
  text: `Tool: ${title}`,
  blocks: [
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `:hammer_and_wrench: ${escapeSlackText(title)}${status ? ` · ${escapeSlackText(status)}` : ""}`,
        },
      ],
    },
  ],
});

export const helpText = (): string =>
  [
    "*Slackboard commands*",
    "`/slackboard help` — show this help",
    "`/slackboard status [session-id]` — show session status",
    "`/slackboard stop [session-id]` — cancel the current turn and stop the agent",
    "`/slackboard start [agent] [project]` — configure this channel and start a thread",
    "`/slackboard agents` — list enabled agents",
    "`/slackboard projects` — list projects",
    "`/slackboard skill list` — list enabled skills",
    "`/slackboard skill use <slug>` — attach a skill to this channel's session",
    "`/slackboard memory list` — list project memory",
    "`/slackboard memory save <text>` — save project memory (explicit save)",
    "`/slackboard commands` — list commands advertised by the selected ACP agent",
    "`/slackboard doctor [agent]` — run the agent connection doctor",
    "",
    "Mention the bot in a channel thread, or send a direct message, to talk to the selected agent.",
  ].join("\n");

export const approvalsListText = (approvals: ApprovalRecord[]): string => {
  if (approvals.length === 0) return "No pending approvals.";
  return approvals
    .map(
      (approval) =>
        `• \`${approval.id}\` — ${escapeSlackText(truncateSlackText(approval.title, 120))} (expires ${approval.expiresAt})`,
    )
    .join("\n");
};
