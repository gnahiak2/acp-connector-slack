import type { FastifyServerOptions } from "fastify";

export const loggerOptions = (level: string): FastifyServerOptions["logger"] => ({
  level,
  redact: {
    paths: [
      "req.headers.cookie",
      "req.headers.authorization",
      "req.headers['x-slackboard-csrf']",
      "res.headers['set-cookie']",
      "*.password",
      "*.token",
      "*.secret",
    ],
    censor: "[REDACTED]",
  },
});
