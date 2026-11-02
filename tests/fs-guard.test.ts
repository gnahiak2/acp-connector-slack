import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceGuard } from "../packages/acp/src/fs-guard.js";

const roots: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "slackboard-fs-"));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const guardFor = async (root: string, maxBytes = 1024): Promise<WorkspaceGuard> => {
  const guard = new WorkspaceGuard([root], maxBytes);
  await guard.init();
  return guard;
};

describe("workspace containment", () => {
  it("reads files inside the root and honours line windows", async () => {
    const root = temp();
    writeFileSync(join(root, "file.txt"), "one\ntwo\nthree\n");
    const guard = await guardFor(root);
    const result = await guard.readTextFile({ sessionId: "s", path: join(root, "file.txt") });
    expect(result.content).toContain("two");
    const window = await guard.readTextFile({
      sessionId: "s",
      path: join(root, "file.txt"),
      line: 2,
      limit: 1,
    });
    expect(window.content).toBe("two");
  });

  it("rejects paths outside the root and symlink escapes", async () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
    const guard = await guardFor(root);
    await expect(
      guard.readTextFile({ sessionId: "s", path: join(outside, "secret.txt") }),
    ).rejects.toThrow(/outside the session workspace/);
    await expect(
      guard.readTextFile({ sessionId: "s", path: join(root, "escape.txt") }),
    ).rejects.toThrow(/outside the session workspace/);
  });

  it("refuses writes outside, through symlinks, or over the size limit", async () => {
    const root = temp();
    const outside = temp();
    writeFileSync(join(outside, "target.txt"), "keep");
    symlinkSync(join(outside, "target.txt"), join(root, "link.txt"));
    const guard = await guardFor(root, 8);
    await expect(
      guard.writeTextFile({ sessionId: "s", path: join(outside, "target.txt"), content: "x" }),
    ).rejects.toThrow(/outside/);
    await expect(
      guard.writeTextFile({ sessionId: "s", path: join(root, "link.txt"), content: "x" }),
    ).rejects.toThrow(/symbolic link/);
    await expect(
      guard.writeTextFile({ sessionId: "s", path: join(root, "big.txt"), content: "too long!" }),
    ).rejects.toThrow(/size limit/);
    expect(readFileSync(join(outside, "target.txt"), "utf8")).toBe("keep");
  });

  it("writes new files atomically inside the root", async () => {
    const root = temp();
    const guard = await guardFor(root);
    await guard.writeTextFile({ sessionId: "s", path: join(root, "new.txt"), content: "hello" });
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("hello");
  });

  it("rejects missing parent directories", async () => {
    const root = temp();
    mkdirSync(join(root, "sub"));
    const guard = await guardFor(root);
    await expect(
      guard.writeTextFile({
        sessionId: "s",
        path: join(root, "sub", "missing", "file.txt"),
        content: "x",
      }),
    ).rejects.toThrow(/Parent directory does not exist/);
  });
});
