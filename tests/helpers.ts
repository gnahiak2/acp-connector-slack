import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const makeGitRepo = (): string => {
  const repo = mkdtempSync(join(tmpdir(), "slackboard-repo-"));
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "hello\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "init"]);
  execFileSync("git", ["-C", repo, "branch", "-M", "main"]);
  return repo;
};

export const removeDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};
