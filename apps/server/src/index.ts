import { existsSync } from "node:fs";
import { APP_VERSION, loadConfig } from "@slackboard/shared";
import { createServices } from "./services.js";
import { buildApp } from "./app.js";
import { SlackBridge } from "./slack/bridge.js";

if (existsSync(".env")) {
  process.loadEnvFile(".env");
}

const main = async (): Promise<void> => {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
    return;
  }

  const services = await createServices(config);
  const app = await buildApp(services);
  const bridge = new SlackBridge(services);

  if (config.runner.type === "local") {
    app.log.warn(
      "Trusted-local runner enabled: agents run with the server account's OS permissions. ACP path checks are not a sandbox.",
    );
  }
  const loopback = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
  if (
    !loopback.has(config.host) &&
    !config.publicUrl?.startsWith("https://") &&
    !config.allowInsecureHttp
  ) {
    app.log.warn(
      "Dashboard is bound beyond loopback without an https PUBLIC_URL; use a TLS reverse proxy or set ALLOW_INSECURE_HTTP explicitly.",
    );
  }
  if (config.slack.allowedUsers.length === 0) {
    app.log.warn("SLACK_ALLOWED_USERS is empty: every Slack request will be denied.");
  }
  if (config.slack.allowedChannels.length === 0) {
    app.log.warn("SLACK_ALLOWED_CHANNELS is empty: every channel request will be denied.");
  }
  if (!services.github.configured) {
    app.log.info("GitHub App integration is not configured.");
  }

  try {
    await bridge.start();
    if (services.health.slackConnected) app.log.info("Slack Socket Mode connected.");
  } catch (error) {
    services.health.slackConnected = false;
    services.health.slackLastError = error instanceof Error ? error.message : String(error);
    app.log.error({ err: error }, "Slack failed to start; dashboard remains available");
  }

  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { version: APP_VERSION, mode: config.mode, host: config.host, port: config.port },
    "slackboard listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      process.stderr.write("Forced shutdown after timeout\n");
      process.exit(1);
    }, 20_000);
    force.unref();
    try {
      await bridge.stop();
      await services.queue.shutdown();
      await services.approvals.shutdown();
      await app.close();
      services.db.close();
    } catch (error) {
      process.stderr.write(`Shutdown error: ${error instanceof Error ? error.message : String(error)}\n`);
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
};

main().catch((error) => {
  process.stderr.write(`Fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
