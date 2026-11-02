import { constants } from "node:fs";
import { lstat, open, readFile, realpath, rename, stat, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { RequestError, type ReadTextFileRequest, type ReadTextFileResponse, type WriteTextFileRequest } from "@agentclientprotocol/sdk";

const within = (root: string, candidate: string): boolean => {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

export class WorkspaceGuard {
  private roots: string[] = [];

  constructor(
    roots: string[],
    private readonly maxFileBytes: number,
  ) {
    this.rootInputs = roots;
  }

  private readonly rootInputs: string[];

  async init(): Promise<void> {
    const resolved: string[] = [];
    for (const root of this.rootInputs) {
      if (!isAbsolute(root)) throw new Error("Workspace roots must be absolute");
      const canonical = await realpath(root);
      if (!(await stat(canonical)).isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`);
      resolved.push(canonical);
    }
    this.roots = resolved;
  }

  get canonicalRoots(): string[] {
    return [...this.roots];
  }

  private assertInitialized(): void {
    if (this.roots.length === 0) throw new Error("WorkspaceGuard is not initialized");
  }

  async resolveExisting(input: string): Promise<string> {
    this.assertInitialized();
    if (!input || input.includes("\0")) throw RequestError.invalidParams({ path: input }, "Invalid path");
    if (!isAbsolute(input)) throw RequestError.invalidParams({ path: input }, "Path must be absolute");
    let canonical: string;
    try {
      canonical = await realpath(resolve(input));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RequestError(-32002, "File not found", { path: input });
      }
      throw RequestError.invalidParams({ path: input }, "Path cannot be resolved");
    }
    if (!this.roots.some((root) => within(root, canonical))) {
      throw RequestError.invalidParams({ path: input }, "Path is outside the session workspace");
    }
    return canonical;
  }

  async resolveForWrite(input: string): Promise<string> {
    this.assertInitialized();
    if (!input || input.includes("\0")) throw RequestError.invalidParams({ path: input }, "Invalid path");
    if (!isAbsolute(input)) throw RequestError.invalidParams({ path: input }, "Path must be absolute");
    const absolute = resolve(input);
    const parent = resolve(absolute, "..");
    let canonicalParent: string;
    try {
      canonicalParent = await realpath(parent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw RequestError.invalidParams({ path: input }, "Parent directory does not exist");
      }
      throw RequestError.invalidParams({ path: input }, "Parent directory cannot be resolved");
    }
    if (!this.roots.some((root) => within(root, canonicalParent))) {
      throw RequestError.invalidParams({ path: input }, "Path is outside the session workspace");
    }
    try {
      const info = await lstat(absolute);
      if (info.isDirectory()) {
        throw RequestError.invalidParams({ path: input }, "Path is a directory");
      }
      if (info.isSymbolicLink()) {
        throw RequestError.invalidParams(
          { path: input },
          "Writing through a symbolic link is not allowed",
        );
      }
      const canonical = await realpath(absolute);
      if (!this.roots.some((root) => within(root, canonical))) {
        throw RequestError.invalidParams({ path: input }, "Path is outside the session workspace");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return join(canonicalParent, absolute.slice(parent.length).replace(/^[\\/]+/, ""));
  }

  async readTextFile(request: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    const canonical = await this.resolveExisting(request.path);
    const info = await stat(canonical);
    if (!info.isFile()) throw RequestError.invalidParams({ path: request.path }, "Path is not a file");
    if (info.size > this.maxFileBytes) {
      throw RequestError.invalidParams(
        { path: request.path, size: info.size, limit: this.maxFileBytes },
        "File exceeds the configured size limit",
      );
    }
    let content: string;
    try {
      content = await readFile(canonical, "utf8");
    } catch {
      throw RequestError.invalidParams({ path: request.path }, "File cannot be read as UTF-8 text");
    }
    if (request.line === undefined || request.line === null) return { content };
    const start = Math.max(1, request.line);
    const lines = content.split(/\r?\n/);
    const count = request.limit === undefined || request.limit === null ? undefined : Math.max(0, request.limit);
    const selected = lines.slice(start - 1, count === undefined ? undefined : start - 1 + count);
    return { content: selected.join("\n") };
  }

  async writeTextFile(request: WriteTextFileRequest): Promise<Record<string, never>> {
    const bytes = Buffer.byteLength(request.content, "utf8");
    if (bytes > this.maxFileBytes) {
      throw RequestError.invalidParams(
        { path: request.path, size: bytes, limit: this.maxFileBytes },
        "Content exceeds the configured size limit",
      );
    }
    const target = await this.resolveForWrite(request.path);
    const temporary = `${target}.slackboard-${randomBytes(6).toString("hex")}.tmp`;
    let handle;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(request.content, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, target);
      return {};
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  async resolveDirectory(input: string): Promise<string> {
    const canonical = await this.resolveExisting(input);
    const info = await stat(canonical);
    if (!info.isDirectory()) {
      throw RequestError.invalidParams({ path: input }, "Path is not a directory");
    }
    return canonical;
  }
}
