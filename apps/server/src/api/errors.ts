import type { FastifyReply } from "fastify";
import { ZodError, type z } from "zod";
import { SessionForbiddenError, SessionNotFoundError, SessionValidationError, SetupRequiredError } from "../core/session-service.js";
import { ApprovalConflictError, ApprovalForbiddenError, ApprovalNotFoundError } from "../core/approvals.js";
import { MemoryNotFoundError, MemoryValidationError } from "../core/memory-service.js";
import { SkillNotFoundError, SkillValidationError } from "../core/skill-service.js";
import { McpNotFoundError, McpValidationError } from "../core/mcp-service.js";
import { WorkspaceError } from "../core/workspace.js";
import { QueueError } from "../core/jobs.js";
import { GithubError, GithubNotConfiguredError } from "@slackboard/integrations";

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export const parseBody = <S extends z.ZodType>(schema: S, body: unknown): z.infer<S> => {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HttpError(
      400,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
    );
  }
  return parsed.data;
};

export const errorStatus = (error: unknown): { status: number; message: string } => {
  if (error instanceof HttpError) return { status: error.statusCode, message: error.message };
  if (error instanceof ZodError) {
    return {
      status: 400,
      message: error.issues.map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`).join("; "),
    };
  }
  if (
    error instanceof SessionNotFoundError ||
    error instanceof ApprovalNotFoundError ||
    error instanceof MemoryNotFoundError ||
    error instanceof SkillNotFoundError ||
    error instanceof McpNotFoundError
  ) {
    return { status: 404, message: error.message };
  }
  if (
    error instanceof SessionForbiddenError ||
    error instanceof ApprovalForbiddenError
  ) {
    return { status: 403, message: error.message };
  }
  if (error instanceof GithubNotConfiguredError) {
    return { status: 409, message: error.message };
  }
  if (
    error instanceof SessionValidationError ||
    error instanceof MemoryValidationError ||
    error instanceof SkillValidationError ||
    error instanceof McpValidationError ||
    error instanceof WorkspaceError ||
    error instanceof GithubError
  ) {
    return { status: 400, message: error.message };
  }
  if (
    error instanceof ApprovalConflictError ||
    error instanceof QueueError ||
    error instanceof SetupRequiredError
  ) {
    return { status: 409, message: error.message };
  }
  return { status: 500, message: "Internal server error" };
};

export const replyError = (reply: FastifyReply, error: unknown): void => {
  const { status, message } = errorStatus(error);
  reply.code(status).send({ error: message });
};
