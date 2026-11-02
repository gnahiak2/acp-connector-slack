import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseList, verifyPassword, validateAgentForDeployment } from "../packages/shared/src/index.js";

const base = (): NodeJS.ProcessEnv => ({
  ADMIN_PASSWORD: "correct horse battery",
  DATA_DIR: mkdtempSync(join(tmpdir(), "slackboard-config-")),
});

describe("configuration", () => {
  it("loads safe local defaults and hashes the admin password", () => {
    const env = base();
    const config = loadConfig(env);
    expect(config.mode).toBe("local");
    expect(config.host).toBe("127.0.0.1");
    expect(config.runner.type).toBe("local");
    expect(config.auth.passwordHash).not.toContain(env.ADMIN_PASSWORD);
    expect(verifyPassword("correct horse battery", config.auth)).toBe(true);
    expect(verifyPassword("wrong password", config.auth)).toBe(false);
    expect(config.skillsRoot.endsWith("skills")).toBe(true);
    rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("rejects short passwords and half-configured Slack tokens", () => {
    expect(() => loadConfig({ ADMIN_PASSWORD: "short" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({ ...base(), SLACK_BOT_TOKEN: "xoxb-123456789012" }),
    ).toThrow(/SLACK_BOT_TOKEN and SLACK_APP_TOKEN/);
  });

  it("requires container isolation and HTTPS in server mode", () => {
    const env = {
      ...base(),
      SLACKBOARD_MODE: "server",
      PUBLIC_URL: "https://agents.example.com",
      RUNNER_TYPE: "container",
      CONTAINER_IMAGE: "ghcr.io/example/agent:1",
    };
    expect(() =>
      loadConfig({ ...env, RUNNER_TYPE: "local" }),
    ).toThrow(/requires RUNNER_TYPE=container/);
    expect(() =>
      loadConfig({ ...env, CONTAINER_IMAGE: undefined }),
    ).toThrow(/requires CONTAINER_IMAGE/);
    expect(() => loadConfig({ ...env, PUBLIC_URL: undefined })).toThrow(/requires PUBLIC_URL/);
    expect(() =>
      loadConfig({ ...env, PUBLIC_URL: "http://agents.example.com" }),
    ).toThrow(/requires an https PUBLIC_URL/);
    const config = loadConfig({ ...env, CONTAINER_IMAGE_ALLOWLIST: "ghcr.io/example/agent:1" });
    expect(config.mode).toBe("server");
    expect(config.auth.secureCookies).toBe(true);
    expect(config.redactValues.length).toBeGreaterThan(0);
    rmSync(config.dataDir, { recursive: true, force: true });
  });

  it("validates GitHub configuration as a group", () => {
    expect(() => loadConfig({ ...base(), GITHUB_APP_ID: "1" })).toThrow(
      /GITHUB_APP_ID, GITHUB_PRIVATE_KEY_PATH and GITHUB_INSTALLATION_ID/,
    );
  });

  it("parses allowlists without duplicates", () => {
    expect(parseList("C1, C2, C1, , C3")).toEqual(["C1", "C2", "C3"]);
    expect(parseList(undefined)).toEqual([]);
    expect(parseList("*")).toEqual(["*"]);
  });

  it("refuses local agents in server mode", () => {
    const config = loadConfig({
      ...base(),
      SLACKBOARD_MODE: "server",
      RUNNER_TYPE: "container",
      CONTAINER_IMAGE: "image:1",
      PUBLIC_URL: "https://agents.example.com",
    });
    expect(() =>
      validateAgentForDeployment(config, {
        id: "local-agent",
        name: "Local",
        executable: "/bin/echo",
        args: [],
        env: [],
        runner: "local",
        enabled: true,
        preset: false,
      }),
    ).toThrow(/not allowed in server mode/);
    rmSync(config.dataDir, { recursive: true, force: true });
  });
});
