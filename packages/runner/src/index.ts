import type { AppConfig, AgentProfile } from "@slackboard/shared";
import { DockerRunner } from "./container.js";
import { LocalRunner } from "./local.js";
import { RunnerError, type Runner } from "./types.js";

export * from "./types.js";
export * from "./local.js";
export * from "./container.js";

export const createRunner = (config: AppConfig): Runner => {
  if (config.runner.type === "container") {
    if (!config.runner.containerImage) {
      throw new RunnerError("CONTAINER_IMAGE is required for the container runner");
    }
    return new DockerRunner({
      image: config.runner.containerImage,
      imageAllowlist: config.runner.imageAllowlist,
      network: config.runner.network,
      memoryMb: config.runner.memoryMb,
      cpus: config.runner.cpus,
      pidsLimit: config.runner.pidsLimit,
    });
  }
  return new LocalRunner();
};

export const runnerForAgent = (config: AppConfig, profile: AgentProfile): Runner => {
  if (profile.runner === "container") {
    if (!config.runner.containerImage) {
      throw new RunnerError("Container agent requires CONTAINER_IMAGE");
    }
    return new DockerRunner({
      image: config.runner.containerImage,
      imageAllowlist: config.runner.imageAllowlist,
      network: config.runner.network,
      memoryMb: config.runner.memoryMb,
      cpus: config.runner.cpus,
      pidsLimit: config.runner.pidsLimit,
    });
  }
  if (config.mode === "server") {
    throw new RunnerError("The trusted-local runner is disabled in server mode");
  }
  return new LocalRunner();
};
