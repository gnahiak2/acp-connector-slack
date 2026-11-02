import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile as readFileFs, readdir, realpath, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AppConfig, ProjectRecord, SessionRecord } from "@slackboard/shared";
import { redactText, truncateUtf8 } from "@slackboard/shared";
import type { GithubService } from "@slackboard/integrations";
import type { EventService } from "./events.js";
import type { Repositories } from "../db/index.js";

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 180_000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceError";
  }
}

export interface WorkspaceEntry {
  path: string;
  name: string;
  type: "file" | "directory" | "symlink";
  size?: number;
}

export interface WorkspaceDiff {
  isGit: boolean;
  status: string;
  diff: string;
  truncated: boolean;
}

const within = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".venv",
  "venv",
  "target",
  ".next",
]);

export class WorkspaceManager {
  constructor(
    private readonly config: AppConfig,
    private readonly repos: Repositories,
    private readonly events: EventService,
    private readonly github: GithubService,
  ) {}

  async workspacePathFor(project: ProjectRecord, sessionId: string): Promise<string> {
    if (project.repository) return join(this.config.workspaceRoot, sessionId);
    if (!project.localPath) {
      throw new WorkspaceError(`Project ${project.name} has no local path or repository`);
    }
    if (!isAbsolute(project.localPath)) {
      throw new WorkspaceError("Project local path must be absolute");
    }
    if (!existsSync(project.localPath) || !(await stat(project.localPath)).isDirectory()) {
      throw new WorkspaceError(`Project local path does not exist: ${project.localPath}`);
    }
    if (await this.isGitRepository(project.localPath)) {
      return join(this.config.workspaceRoot, sessionId);
    }
    return project.localPath;
  }

  lockKey(project: ProjectRecord): string {
    if (project.repository) return `session`;
    if (project.localPath) return `path:${resolve(project.localPath)}`;
    return `session`;
  }

  async ensure(session: SessionRecord, project: ProjectRecord): Promise<string> {
    const workspace = session.workspacePath;
    if (!isAbsolute(workspace)) throw new WorkspaceError("Workspace path must be absolute");
    const agent = this.repos.agents.byId(session.agentId);
    if (
      agent?.runner === "container" &&
      project.localPath &&
      !project.repository &&
      !(await this.isGitRepository(project.localPath))
    ) {
      throw new WorkspaceError(
        "Container-backed agents require a repository or a git local path for an isolated workspace",
      );
    }
    if (existsSync(workspace)) {
      if (!(await stat(workspace)).isDirectory()) {
        throw new WorkspaceError(`Workspace path is not a directory: ${workspace}`);
      }
      return workspace;
    }
    await mkdir(this.config.workspaceRoot, { recursive: true });
    if (!within(this.config.workspaceRoot, workspace)) {
      throw new WorkspaceError("Workspace path is outside WORKSPACE_ROOT");
    }
    if (project.repository) {
      await this.cloneRepository(project, workspace);
    } else if (project.localPath) {
      if (agent?.runner === "container") {
        await this.cloneLocalRepository(project.localPath, workspace, project.defaultBranch);
      } else {
        await this.addWorktree(project.localPath, workspace);
      }
    } else {
      throw new WorkspaceError(`Project ${project.name} has no source`);
    }
    this.events.append({
      sessionId: session.id,
      type: "workspace.ready",
      payload: { path: workspace },
    });
    return workspace;
  }

  async isGitRepository(path: string): Promise<boolean> {
    try {
      const result = await this.git(path, ["rev-parse", "--is-inside-work-tree"]);
      return result.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async diff(session: SessionRecord, maxBytes = 512 * 1024): Promise<WorkspaceDiff> {
    const workspace = session.workspacePath;
    if (!existsSync(workspace) || !(await this.isGitRepository(workspace))) {
      return { isGit: false, status: "", diff: "", truncated: false };
    }
    const statusResult = await this.git(workspace, ["status", "--porcelain=v1", "--untracked-files=all"]);
    let diffText: string;
    try {
      const diffResult = await this.git(workspace, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD",
      ]);
      diffText = diffResult.stdout;
    } catch {
      diffText = "";
    }
    const truncated = Buffer.byteLength(diffText, "utf8") > maxBytes;
    return {
      isGit: true,
      status: this.redact(statusResult.stdout).trim(),
      diff: truncated ? truncateUtf8(diffText, maxBytes).text : this.redact(diffText),
      truncated,
    };
  }

  async listFiles(
    session: SessionRecord,
    relativePath = "",
    limit = 500,
  ): Promise<WorkspaceEntry[]> {
    const root = await realpath(session.workspacePath);
    const requested = resolve(root, relativePath || ".");
    if (!within(root, requested)) throw new WorkspaceError("Path is outside the workspace");
    const canonical = await realpath(requested);
    if (!within(root, canonical)) throw new WorkspaceError("Path is outside the workspace");
    const entries: WorkspaceEntry[] = [];
    const queue: Array<{ directory: string; depth: number }> = [{ directory: canonical, depth: 0 }];
    while (queue.length > 0 && entries.length < limit) {
      const current = queue.shift()!;
      if (current.depth > 2) continue;
      const children = await readdir(current.directory, { withFileTypes: true });
      children.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      for (const child of children) {
        if (entries.length >= limit) break;
        if (child.name === ".git") continue;
        const absolute = join(current.directory, child.name);
        const rel = relative(root, absolute).split(sep).join("/");
        if (child.isDirectory()) {
          if (SKIPPED_DIRECTORIES.has(child.name)) {
            entries.push({ path: rel, name: child.name, type: "directory" });
            continue;
          }
          entries.push({ path: rel, name: child.name, type: "directory" });
          queue.push({ directory: absolute, depth: current.depth + 1 });
        } else if (child.isSymbolicLink()) {
          entries.push({ path: rel, name: child.name, type: "symlink" });
        } else {
          const info = await stat(absolute).catch(() => undefined);
          entries.push({ path: rel, name: child.name, type: "file", size: info?.size });
        }
      }
    }
    return entries;
  }

  async readWorkspaceFile(
    session: SessionRecord,
    relativePath: string,
    maxBytes = 256 * 1024,
  ): Promise<{ content: string; truncated: boolean; binary: boolean }> {
    const root = await realpath(session.workspacePath);
    const requested = resolve(root, relativePath);
    if (!within(root, requested)) throw new WorkspaceError("Path is outside the workspace");
    const canonical = await realpath(requested);
    if (!within(root, canonical)) throw new WorkspaceError("Path is outside the workspace");
    const info = await stat(canonical);
    if (!info.isFile()) throw new WorkspaceError("Path is not a file");
    if (info.size > maxBytes) {
      throw new WorkspaceError(`File is larger than ${maxBytes} bytes`);
    }
    const buffer = await readFileFs(canonical);
    if (buffer.includes(0)) return { content: "", truncated: false, binary: true };
    return { content: buffer.toString("utf8"), truncated: false, binary: false };
  }

  async changedFiles(session: SessionRecord): Promise<Array<{ path: string; content: string }>> {
    const workspace = session.workspacePath;
    if (!(await this.isGitRepository(workspace))) return [];
    const tracked = await this.git(workspace, ["diff", "--name-only", "HEAD"]);
    const untracked = await this.git(workspace, [
      "ls-files",
      "--others",
      "--exclude-standard",
    ]);
    const paths = new Set(
      `${tracked.stdout}\n${untracked.stdout}`
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    );
    const files: Array<{ path: string; content: string }> = [];
    for (const path of [...paths].slice(0, 100)) {
      const absolute = resolve(workspace, path);
      if (!within(workspace, absolute)) continue;
      const info = await stat(absolute).catch(() => undefined);
      if (!info?.isFile() || info.size > 512 * 1024) continue;
      const buffer = await readFileFs(absolute);
      if (buffer.includes(0)) continue;
      files.push({ path, content: buffer.toString("utf8") });
    }
    return files;
  }

  private async cloneRepository(project: ProjectRecord, target: string): Promise<void> {
    const repository = project.repository!;
    const url = this.normalizeRepositoryUrl(repository);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: this.config.dataDir,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
    };
    const githubRepo = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository);
    if (githubRepo && new URL(url).hostname === "github.com" && this.github.configured) {
      try {
        const credentials = await this.github.createCloneToken(repository);
        const basic = Buffer.from(`x-access-token:${credentials.token}`).toString("base64");
        env.GIT_CONFIG_COUNT = "1";
        env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
        env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
      } catch {
        // Fall back to an unauthenticated clone for public repositories.
      }
    }
    try {
      await execFileAsync(
        "git",
        [
          "clone",
          "--depth",
          "1",
          "--single-branch",
          "--branch",
          project.defaultBranch,
          "--",
          url,
          target,
        ],
        { env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      );
    } catch (error) {
      throw new WorkspaceError(`Cannot clone ${repository}: ${this.redact((error as Error).message)}`);
    }
  }

  private async addWorktree(localPath: string, target: string): Promise<void> {
    if (this.config.mode === "server") {
      const canonicalRoot = await realpath(this.config.workspaceRoot);
      if (!within(canonicalRoot, target)) {
        throw new WorkspaceError("Server-mode worktrees must live under WORKSPACE_ROOT");
      }
    }
    try {
      await this.git(localPath, ["worktree", "add", "--detach", target, "HEAD"]);
    } catch (error) {
      throw new WorkspaceError(`Cannot create workspace worktree: ${(error as Error).message}`);
    }
  }

  private async cloneLocalRepository(
    localPath: string,
    target: string,
    branch: string,
  ): Promise<void> {
    try {
      await execFileAsync(
        "git",
        ["clone", "--single-branch", "--branch", branch, "--", localPath, target],
        {
          env: {
            PATH: process.env.PATH,
            HOME: this.config.dataDir,
            GIT_TERMINAL_PROMPT: "0",
            GIT_CONFIG_NOSYSTEM: "1",
          },
          timeout: GIT_TIMEOUT_MS,
          maxBuffer: GIT_MAX_BUFFER,
        },
      );
    } catch (error) {
      throw new WorkspaceError(
        `Cannot clone local repository into an isolated workspace: ${this.redact((error as Error).message)}`,
      );
    }
  }

  normalizeRepositoryUrl(repository: string): string {
    if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      return `https://github.com/${repository}.git`;
    }
    let url: URL;
    try {
      url = new URL(repository);
    } catch {
      throw new WorkspaceError("Repository must be owner/name or an https URL");
    }
    if (url.protocol !== "https:") {
      throw new WorkspaceError("Repository URL must use https");
    }
    if (url.username || url.password) {
      throw new WorkspaceError("Repository URL must not contain credentials");
    }
    return repository;
  }

  private async git(
    cwd: string,
    args: string[],
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const result = await execFileAsync("git", ["-C", cwd, ...args], {
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER,
        env: {
          PATH: process.env.PATH,
          HOME: this.config.dataDir,
          GIT_TERMINAL_PROMPT: "0",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      });
      return { stdout: result.stdout, stderr: result.stderr };
    } catch (error) {
      const message = (error as Error).message;
      throw new WorkspaceError(this.redact(message));
    }
  }

  private redact(value: string): string {
    return redactText(value, this.config.redactValues);
  }
}
