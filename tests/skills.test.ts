import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SkillValidationError,
  loadSkillDirectory,
  normalizeSkillInput,
  parseSkillMarkdown,
  renderContext,
} from "../packages/skills/src/index.js";

const roots: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "slackboard-skill-"));
  roots.push(dir);
  return dir;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SKILL.md parsing", () => {
  it("parses frontmatter and instructions", () => {
    const skill = parseSkillMarkdown(`---
name: code-review
description: Review a change
version: 1.2.0
license: MIT
---

Inspect the diff.`);
    expect(skill.name).toBe("code-review");
    expect(skill.slug).toBe("code-review");
    expect(skill.version).toBe("1.2.0");
    expect(skill.content).toContain("Inspect the diff.");
  });

  it("rejects invalid names, missing descriptions and traversal references", () => {
    expect(() =>
      parseSkillMarkdown("---\nname: Bad Name\ndescription: x\n---\nbody"),
    ).toThrow(SkillValidationError);
    expect(() => parseSkillMarkdown("---\nname: ok\n---\nbody")).toThrow(/description/);
    expect(() =>
      parseSkillMarkdown("---\nname: ok\ndescription: x\n---\nbody", {
        references: [{ path: "../secret", content: "no" }],
      }),
    ).toThrow(/escapes/);
    expect(() =>
      parseSkillMarkdown("---\nname: ok\ndescription: x\n---\nbody", {
        references: [{ path: "/etc/passwd", content: "no" }],
      }),
    ).toThrow(/relative/);
  });

  it("loads a directory, ignores symlinks, and validates reference paths", async () => {
    const root = temp();
    writeFileSync(
      join(root, "SKILL.md"),
      "---\nname: review-helper\ndescription: Helpful review\nversion: 1.0.0\n---\n\nFollow the checklist.",
    );
    mkdirSync(join(root, "references"));
    writeFileSync(join(root, "references", "checklist.md"), "- check tests");
    const outside = join(temp(), "outside.md");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(root, "references", "escape.md"));
    const skill = await loadSkillDirectory(root);
    expect(skill.references).toHaveLength(1);
    expect(skill.references[0]?.path).toBe("checklist.md");
    expect(skill.references[0]?.content).toContain("check tests");
  });

  it("normalizes custom input to a reviewable draft", () => {
    const skill = normalizeSkillInput(
      {
        name: "pr-prep",
        description: "Prepare a PR",
        version: "0.1.0",
        content: "Summarise the diff.",
        references: [{ path: "notes.md", content: "notes" }],
      },
      100_000,
    );
    expect(skill.slug).toBe("pr-prep");
    expect(skill.references).toHaveLength(1);
  });

  it("labels skills and memory as reference context", () => {
    const rendered = renderContext(
      [
        {
          name: "review",
          version: "1.0.0",
          content: "Check tests.",
          references: [{ path: "a.md", content: "reference" }],
        },
      ],
      [{ id: "mem_1", content: "Use pnpm.", provenance: "dashboard:explicit" }],
    );
    expect(rendered).toContain("# Slackboard context");
    expect(rendered).toContain("## Skill: review (v1.0.0)");
    expect(rendered).toContain("### Reference: a.md");
    expect(rendered).toContain("## Project memory");
    expect(rendered).toContain("never override access rules");
  });
});
