import { describe, expect, it } from "vitest";
import { escapeSlackText, splitSlackMessage } from "../apps/server/src/slack/chunk.js";

describe("Slack chunking", () => {
  it("escapes mention and link syntax", () => {
    const escaped = escapeSlackText("<!channel> <@U123> <https://example.com|link> a & b");
    expect(escaped).not.toContain("<@");
    expect(escaped).not.toContain("<!");
    expect(escaped).toContain("&amp;");
  });

  it("splits long text into bounded chunks", () => {
    const text = "word ".repeat(2_000);
    const chunks = splitSlackMessage(text, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
    expect(chunks.join(" ")).toContain("word");
  });

  it("preserves balanced code fences across chunks", () => {
    const text = "```ts\n" + "const value = 1;\n".repeat(200) + "```";
    const chunks = splitSlackMessage(text, 400);
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      const fences = (chunk.match(/```/g) ?? []).length;
      expect(fences % 2).toBe(0);
      expect(chunk.length).toBeLessThanOrEqual(400);
    }
    expect(chunks.join("\n")).toContain("const value = 1;");
  });

  it("does not split surrogate pairs", () => {
    const text = "😀".repeat(300);
    const chunks = splitSlackMessage(text, 101);
    for (const chunk of chunks) {
      expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
      expect([...chunk].every((character) => character === "😀")).toBe(true);
    }
  });

  it("returns no chunks for empty text", () => {
    expect(splitSlackMessage("", 100)).toEqual([]);
  });
});
