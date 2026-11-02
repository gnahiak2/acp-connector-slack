import { z } from "zod";

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const mcpInputSchema = z
  .object({
    name: z.string().min(1).max(80),
    transport: z.enum(["stdio", "http", "sse"]),
    command: z.string().max(4096).optional(),
    args: z.array(z.string().max(4096)).max(64).default([]),
    envRefs: z.array(z.string().regex(ENV_NAME)).max(64).default([]),
    url: z.string().max(4096).optional(),
    headerRefs: z
      .array(
        z.object({
          name: z.string().min(1).max(200),
          envVar: z.string().regex(ENV_NAME),
        }),
      )
      .max(32)
      .default([]),
    enabled: z.boolean().default(true),
  })
  .superRefine((input, ctx) => {
    if (input.transport === "stdio") {
      if (!input.command || !input.command.startsWith("/")) {
        ctx.addIssue({
          code: "custom",
          path: ["command"],
          message: "stdio transport requires an absolute command path",
        });
      }
      if (input.url) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "stdio transport cannot use a URL" });
      }
    } else {
      if (!input.url) {
        ctx.addIssue({ code: "custom", path: ["url"], message: "URL is required" });
      } else {
        let url: URL | undefined;
        try {
          url = new URL(input.url);
        } catch {
          ctx.addIssue({ code: "custom", path: ["url"], message: "URL is invalid" });
        }
        if (url) {
          if (url.username || url.password) {
            ctx.addIssue({
              code: "custom",
              path: ["url"],
              message: "Credentials are not allowed in the URL; use header references",
            });
          }
          if (url.protocol !== "https:") {
            ctx.addIssue({ code: "custom", path: ["url"], message: "MCP URLs must use https" });
          }
        }
      }
      if (input.command) {
        ctx.addIssue({
          code: "custom",
          path: ["command"],
          message: "HTTP/SSE transports cannot use a command",
        });
      }
    }
    for (const header of input.headerRefs) {
      if (/[\r\n]/.test(header.name)) {
        ctx.addIssue({ code: "custom", path: ["headerRefs"], message: "Invalid header name" });
      }
    }
  });

export type McpInput = z.infer<typeof mcpInputSchema>;

export const publicMcpView = <T extends { envRefs: string[]; headerRefs: Array<{ name: string; envVar: string }> }>(
  record: T,
): Omit<T, "envRefs" | "headerRefs"> & {
  envRefs: string[];
  headerRefs: Array<{ name: string; envVar: string }>;
} => ({
  ...record,
  envRefs: [...record.envRefs],
  headerRefs: record.headerRefs.map((header) => ({ name: header.name, envVar: header.envVar })),
});
