import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentProfile, DoctorReport } from "@slackboard/shared";
import type { Runner } from "@slackboard/runner";
import { NativeAcpClient, doctorReportFromClient } from "./client.js";
import { emptyDoctorReport } from "./capabilities.js";

export interface DoctorOptions {
  profile: AgentProfile;
  runner: Runner;
  env: Record<string, string>;
  workspaceHostPath?: string;
  limits: {
    maxMessageBytes: number;
    maxFileBytes: number;
    terminalOutputBytes: number;
    startTimeoutMs: number;
  };
}

export const runDoctor = async (options: DoctorOptions): Promise<DoctorReport> => {
  let workspace = options.workspaceHostPath;
  let temporary: string | undefined;
  if (!workspace) {
    temporary = await mkdtemp(join(tmpdir(), "slackboard-doctor-"));
    workspace = temporary;
  }
  const client = new NativeAcpClient({
    profile: options.profile,
    sessionId: `doctor_${Date.now()}`,
    workspaceHostPath: workspace,
    runner: options.runner,
    env: options.env,
    limits: {
      ...options.limits,
      promptTimeoutMs: 10_000,
    },
    hooks: {
      onUpdate: () => undefined,
      onPermission: async () => ({ outcome: "cancelled" }),
    },
  });
  try {
    await client.start();
    return doctorReportFromClient(client, options.profile.id, options.profile.executable, options.profile.args);
  } catch (error) {
    const report = emptyDoctorReport(
      options.profile.id,
      options.profile.executable,
      options.profile.args,
    );
    return {
      ...report,
      authMethods: client.authMethods,
      unsupported: [],
      error: [client.stderr.trim(), error instanceof Error ? error.message : String(error)]
        .filter(Boolean)
        .join("\n")
        .slice(-4000),
    };
  } finally {
    await client.dispose(2_000);
    if (temporary) await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
};
