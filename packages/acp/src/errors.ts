import { RequestError } from "@agentclientprotocol/sdk";

export class AcpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AcpError";
  }
}

export class AcpProtocolError extends AcpError {
  constructor(message: string, code: number, data?: unknown) {
    super(message, code, data);
    this.name = "AcpProtocolError";
  }
}

export interface AuthMethodSummary {
  id: string;
  name: string;
  type: "agent" | "terminal";
  description?: string;
}

export class AcpAuthRequiredError extends AcpError {
  constructor(
    message: string,
    readonly methods: AuthMethodSummary[],
  ) {
    super(message, -32000);
    this.name = "AcpAuthRequiredError";
  }
}

export class AcpUnsupportedError extends AcpError {
  constructor(message: string) {
    super(message);
    this.name = "AcpUnsupportedError";
  }
}

export const asProtocolError = (error: unknown): AcpProtocolError | undefined => {
  if (error instanceof RequestError) {
    return new AcpProtocolError(error.message, error.code, error.data);
  }
  return undefined;
};

export const isAuthRequired = (error: unknown): boolean =>
  error instanceof RequestError
    ? error.code === -32000
    : error instanceof AcpError && error.code === -32000;

export const isSessionNotFound = (error: unknown): boolean =>
  error instanceof RequestError
    ? error.code === -32002
    : error instanceof AcpError && error.code === -32002;

export const isRequestCancelled = (error: unknown): boolean =>
  error instanceof RequestError
    ? error.code === -32800
    : error instanceof AcpError && error.code === -32800;

export const toRequestError = (error: unknown, fallbackMessage: string): RequestError => {
  if (error instanceof RequestError) return error;
  if (error instanceof AcpError) {
    return new RequestError(error.code ?? -32603, error.message, error.data);
  }
  return new RequestError(-32603, error instanceof Error ? error.message : fallbackMessage);
};
