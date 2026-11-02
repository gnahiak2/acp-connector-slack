import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";

export type DeploymentMode = "local" | "server";
export type RunnerType = "local" | "container";

export interface SlackSettings {
  botToken?: string;
  appToken?: string;
  signingSecret?: string;
  allowedChannels: string[];
  allowedUsers: string[];
  defaultAgentId?: string;
  defaultProjectId?: string;
}

export interface GithubSettings {
  appId?: number;
  privateKeyPath?: string;
  installationId?: number;
  allowedRepos: string[];
}

export interface RunnerSettings {
  type: RunnerType;
  containerImage?: string;
  imageAllowlist: string[];
  network: string;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
}

export interface LimitSettings {
  globalConcurrency: number;
  promptTimeoutMs: number;
  approvalTimeoutMs: number;
  agentStartTimeoutMs: number;
  agentIdleTimeoutMs: number;
  maxMessageBytes: number;
  maxFileBytes: number;
  terminalOutputBytes: number;
  maxEventBytes: number;
  maxSkillBytes: number;
  slackChunkChars: number;
  slackUpdateIntervalMs: number;
  memoryRetentionDays?: number;
}

export interface AuthSettings {
  adminUser: string;
  passwordHash: string;
  passwordSalt: string;
  sessionTtlMs: number;
  secureCookies: boolean;
}

export interface AppConfig {
  mode: DeploymentMode;
  host: string;
  port: number;
  publicUrl?: string;
  dataDir: string;
  dbPath: string;
  workspaceRoot: string;
  webDist?: string;
  skillsRoot: string;
  agentsConfigPath: string;
  logLevel: string;
  trustProxy: boolean;
  allowInsecureHttp: boolean;
  slack: SlackSettings;
  github: GithubSettings;
  runner: RunnerSettings;
  limits: LimitSettings;
  auth: AuthSettings;
  redactValues: string[];
}

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return defaultValue;
      const normalized = value.toLowerCase();
      if (["1", "true", "yes", "on"].includes(normalized)) return true;
      if (["0", "false", "no", "off"].includes(normalized)) return false;
      throw new Error(`Expected a boolean, received "${value}"`);
    });

const int = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return defaultValue;
      if (!/^-?\d+$/.test(value)) throw new Error(`Expected an integer, received "${value}"`);
      const parsed = Number.parseInt(value, 10);
      if (parsed < min || parsed > max) {
        throw new Error(`Expected an integer between ${min} and ${max}, received ${parsed}`);
      }
      return parsed;
    });

export const parseList = (value: string | undefined): string[] => {
  if (!value) return [];
  const seen = new Set<string>();
  for (const item of value.split(",")) {
    const trimmed = item.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
};

const optionalString = z
  .string()
  .optional()
  .transform((value) => (value === undefined || value.trim() === "" ? undefined : value.trim()));

const envSchema = z.object({
  SLACKBOARD_MODE: z.enum(["local", "server"]).default("local"),
  HOST: z.string().default("127.0.0.1"),
  PORT: int(8787, 1, 65535),
  PUBLIC_URL: optionalString,
  DATA_DIR: z.string().default("./data"),
  DATABASE_PATH: optionalString,
  WORKSPACE_ROOT: optionalString,
  WEB_DIST: optionalString,
  SKILLS_DIR: z.string().default("./skills"),
  AGENTS_CONFIG: z.string().default("./config/agents.json"),
  LOG_LEVEL: z.string().default("info"),
  TRUST_PROXY: bool(false),
  ALLOW_INSECURE_HTTP: bool(false),

  ADMIN_USER: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(12, "ADMIN_PASSWORD must be at least 12 characters"),
  SESSION_TTL_HOURS: int(12, 1, 24 * 30),

  SLACK_BOT_TOKEN: optionalString,
  SLACK_APP_TOKEN: optionalString,
  SLACK_SIGNING_SECRET: optionalString,
  SLACK_ALLOWED_CHANNELS: z.string().default(""),
  SLACK_ALLOWED_USERS: z.string().default(""),
  SLACK_DEFAULT_AGENT: optionalString,
  SLACK_DEFAULT_PROJECT: optionalString,

  GITHUB_APP_ID: optionalString,
  GITHUB_PRIVATE_KEY_PATH: optionalString,
  GITHUB_INSTALLATION_ID: optionalString,
  GITHUB_ALLOWED_REPOS: z.string().default(""),

  RUNNER_TYPE: z.enum(["local", "container"]).default("local"),
  CONTAINER_IMAGE: optionalString,
  CONTAINER_IMAGE_ALLOWLIST: z.string().default(""),
  CONTAINER_NETWORK: z.string().default("none"),
  CONTAINER_MEMORY_MB: int(1024, 128, 65536),
  CONTAINER_CPUS: z
    .string()
    .optional()
    .transform((value) => {
      if (value === undefined || value === "") return 1;
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 64) {
        throw new Error(`CONTAINER_CPUS must be between 0 and 64, received "${value}"`);
      }
      return parsed;
    }),
  CONTAINER_PIDS_LIMIT: int(256, 16, 65536),

  GLOBAL_CONCURRENCY: int(2, 1, 64),
  PROMPT_TIMEOUT_MS: int(10 * 60_000, 10_000, 24 * 60 * 60_000),
  APPROVAL_TIMEOUT_MS: int(2 * 60_000, 10_000, 24 * 60 * 60_000),
  AGENT_START_TIMEOUT_MS: int(30_000, 1_000, 10 * 60_000),
  AGENT_IDLE_TIMEOUT_MS: int(15 * 60_000, 60_000, 7 * 24 * 60 * 60_000),
  MAX_MESSAGE_BYTES: int(1_048_576, 4_096, 64 * 1_048_576),
  MAX_FILE_BYTES: int(1_048_576, 4_096, 64 * 1_048_576),
  TERMINAL_OUTPUT_BYTES: int(262_144, 4_096, 16 * 1_048_576),
  MAX_EVENT_BYTES: int(65_536, 1_024, 1_048_576),
  MAX_SKILL_BYTES: int(262_144, 1_024, 4 * 1_048_576),
  SLACK_CHUNK_CHARS: int(3_200, 500, 3_900),
  SLACK_UPDATE_INTERVAL_MS: int(800, 250, 10_000),
  MEMORY_RETENTION_DAYS: int(0, 0, 3650),
});

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const hashPassword = (password: string): { passwordHash: string; passwordSalt: string } => {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return { passwordHash: hash.toString("hex"), passwordSalt: salt.toString("hex") };
};

export const verifyPassword = (
  password: string,
  settings: Pick<AuthSettings, "passwordHash" | "passwordSalt">,
): boolean => {
  const expected = Buffer.from(settings.passwordHash, "hex");
  const actual = scryptSync(password, Buffer.from(settings.passwordSalt, "hex"), expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid configuration: ${details}`);
  }
  const raw = parsed.data;
  const dataDir = resolve(raw.DATA_DIR);
  const dbPath = resolve(raw.DATABASE_PATH ?? `${dataDir}/slackboard.db`);
  const workspaceRoot = resolve(raw.WORKSPACE_ROOT ?? `${dataDir}/workspaces`);
  const agentsConfigPath = resolve(raw.AGENTS_CONFIG);
  const skillsRoot = resolve(raw.SKILLS_DIR);
  const webDist = raw.WEB_DIST ? resolve(raw.WEB_DIST) : undefined;

  if (raw.SLACK_BOT_TOKEN || raw.SLACK_APP_TOKEN) {
    if (!raw.SLACK_BOT_TOKEN || !raw.SLACK_APP_TOKEN) {
      throw new ConfigError("SLACK_BOT_TOKEN and SLACK_APP_TOKEN must both be set");
    }
  }

  let github: GithubSettings = { allowedRepos: parseList(raw.GITHUB_ALLOWED_REPOS) };
  const githubFields = [raw.GITHUB_APP_ID, raw.GITHUB_PRIVATE_KEY_PATH, raw.GITHUB_INSTALLATION_ID];
  const githubSet = githubFields.filter((value) => value !== undefined).length;
  if (githubSet > 0 && githubSet < 3) {
    throw new ConfigError(
      "GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH and GITHUB_INSTALLATION_ID must be set together",
    );
  }
  if (githubSet === 3) {
    const appId = Number.parseInt(raw.GITHUB_APP_ID!, 10);
    const installationId = Number.parseInt(raw.GITHUB_INSTALLATION_ID!, 10);
    if (!Number.isFinite(appId) || appId <= 0) throw new ConfigError("GITHUB_APP_ID is invalid");
    if (!Number.isFinite(installationId) || installationId <= 0) {
      throw new ConfigError("GITHUB_INSTALLATION_ID is invalid");
    }
    const privateKeyPath = resolve(raw.GITHUB_PRIVATE_KEY_PATH!);
    if (privateKeyPath && !isAbsolute(privateKeyPath)) {
      throw new ConfigError("GITHUB_PRIVATE_KEY_PATH must be an absolute path");
    }
    github = { ...github, appId, installationId, privateKeyPath };
  }

  const containerImage = raw.CONTAINER_IMAGE;
  const imageAllowlist = parseList(raw.CONTAINER_IMAGE_ALLOWLIST);
  if (containerImage && imageAllowlist.length > 0 && !imageAllowlist.includes(containerImage)) {
    throw new ConfigError("CONTAINER_IMAGE must appear in CONTAINER_IMAGE_ALLOWLIST");
  }

  const mode = raw.SLACKBOARD_MODE;
  const publicUrl = raw.PUBLIC_URL?.replace(/\/+$/, "");
  if (mode === "server") {
    if (raw.RUNNER_TYPE !== "container") {
      throw new ConfigError("Server mode requires RUNNER_TYPE=container with an isolated image");
    }
    if (!containerImage) {
      throw new ConfigError("Server mode requires CONTAINER_IMAGE");
    }
    if (!publicUrl) {
      throw new ConfigError("Server mode requires PUBLIC_URL for origin checks");
    }
    if (!raw.ALLOW_INSECURE_HTTP && new URL(publicUrl).protocol !== "https:") {
      throw new ConfigError("Server mode requires an https PUBLIC_URL unless ALLOW_INSECURE_HTTP=true");
    }
  }

  const redactValues = [
    raw.ADMIN_PASSWORD,
    raw.SLACK_BOT_TOKEN,
    raw.SLACK_APP_TOKEN,
    raw.SLACK_SIGNING_SECRET,
  ].filter((value): value is string => Boolean(value));
  for (const value of [raw.SLACK_BOT_TOKEN, raw.SLACK_APP_TOKEN]) {
    if (value) redactValues.push(createHash("sha256").update(value).digest("hex"));
  }

  return {
    mode,
    host: raw.HOST,
    port: raw.PORT,
    publicUrl,
    dataDir,
    dbPath,
    workspaceRoot,
    webDist,
    skillsRoot,
    agentsConfigPath,
    logLevel: raw.LOG_LEVEL,
    trustProxy: raw.TRUST_PROXY,
    allowInsecureHttp: raw.ALLOW_INSECURE_HTTP,
    slack: {
      botToken: raw.SLACK_BOT_TOKEN,
      appToken: raw.SLACK_APP_TOKEN,
      signingSecret: raw.SLACK_SIGNING_SECRET,
      allowedChannels: parseList(raw.SLACK_ALLOWED_CHANNELS),
      allowedUsers: parseList(raw.SLACK_ALLOWED_USERS),
      defaultAgentId: raw.SLACK_DEFAULT_AGENT,
      defaultProjectId: raw.SLACK_DEFAULT_PROJECT,
    },
    github,
    runner: {
      type: raw.RUNNER_TYPE,
      containerImage,
      imageAllowlist,
      network: raw.CONTAINER_NETWORK,
      memoryMb: raw.CONTAINER_MEMORY_MB,
      cpus: raw.CONTAINER_CPUS,
      pidsLimit: raw.CONTAINER_PIDS_LIMIT,
    },
    limits: {
      globalConcurrency: raw.GLOBAL_CONCURRENCY,
      promptTimeoutMs: raw.PROMPT_TIMEOUT_MS,
      approvalTimeoutMs: raw.APPROVAL_TIMEOUT_MS,
      agentStartTimeoutMs: raw.AGENT_START_TIMEOUT_MS,
      agentIdleTimeoutMs: raw.AGENT_IDLE_TIMEOUT_MS,
      maxMessageBytes: raw.MAX_MESSAGE_BYTES,
      maxFileBytes: raw.MAX_FILE_BYTES,
      terminalOutputBytes: raw.TERMINAL_OUTPUT_BYTES,
      maxEventBytes: raw.MAX_EVENT_BYTES,
      maxSkillBytes: raw.MAX_SKILL_BYTES,
      slackChunkChars: raw.SLACK_CHUNK_CHARS,
      slackUpdateIntervalMs: raw.SLACK_UPDATE_INTERVAL_MS,
      memoryRetentionDays:
        raw.MEMORY_RETENTION_DAYS > 0 ? raw.MEMORY_RETENTION_DAYS : undefined,
    },
    auth: {
      adminUser: raw.ADMIN_USER,
      ...hashPassword(raw.ADMIN_PASSWORD),
      sessionTtlMs: raw.SESSION_TTL_HOURS * 60 * 60_000,
      secureCookies:
        !raw.ALLOW_INSECURE_HTTP &&
        (mode === "server" || Boolean(publicUrl?.startsWith("https://"))),
    },
    redactValues,
  };
};

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const agentProfileSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "id must be lowercase letters, digits and dashes"),
  name: z.string().min(1).max(120),
  description: z.string().max(2000).optional(),
  executable: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes("\0") && !value.includes("\n"), "invalid executable"),
  args: z
    .array(z.string().refine((value) => !value.includes("\0"), "arguments cannot contain NUL"))
    .max(64)
    .default([]),
  env: z
    .array(z.string().regex(ENV_NAME, "env entries must be environment variable names"))
    .max(64)
    .default([]),
  runner: z.enum(["local", "container"]).default("local"),
  authentication: z.string().max(4000).optional(),
  enabled: z.boolean().default(true),
  preset: z.boolean().default(false),
});

export type AgentProfile = z.infer<typeof agentProfileSchema>;

export const agentsFileSchema = z.object({
  agents: z.array(agentProfileSchema).max(100),
});

export const loadAgentsFile = (filePath: string): AgentProfile[] => {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new ConfigError(`Cannot read agents config at ${filePath}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    throw new ConfigError(`Agents config is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = agentsFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new ConfigError(
      `Invalid agents config: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  const ids = new Set<string>();
  for (const profile of parsed.data.agents) {
    if (ids.has(profile.id)) throw new ConfigError(`Duplicate agent id ${profile.id}`);
    ids.add(profile.id);
  }
  return parsed.data.agents;
};

export const validateAgentForDeployment = (config: AppConfig, profile: AgentProfile): void => {
  if (config.mode === "server" && profile.runner !== "container") {
    throw new ConfigError(
      `Agent ${profile.id} uses the trusted-local runner, which is not allowed in server mode`,
    );
  }
  if (profile.runner === "container" && !config.runner.containerImage) {
    throw new ConfigError(`Agent ${profile.id} requires CONTAINER_IMAGE`);
  }
};
