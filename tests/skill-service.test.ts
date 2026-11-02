import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "../apps/server/src/db/database.js";
import { Repositories } from "../apps/server/src/db/index.js";
import { AuditService } from "../apps/server/src/core/audit.js";
import { SkillService } from "../apps/server/src/core/skill-service.js";

const dbs: Database[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const setup = (): SkillService => {
  const db = new Database(":memory:");
  dbs.push(db);
  const repos = new Repositories(db);
  const audit = new AuditService(repos.audit, []);
  const dir = mkdtempSync(join(tmpdir(), "slackboard-skill-svc-"));
  dirs.push(dir);
  return new SkillService(repos, audit, dir, 262_144);
};

describe("skill versioning", () => {
  it("creates drafts and bumps versions on edit instead of overwriting history", () => {
    const service = setup();
    const created = service.create(
      {
        name: "review-notes",
        description: "Write review notes",
        version: "1.0.0",
        content: "First instructions.",
      },
      "admin",
    );
    expect(created.status).toBe("draft");
    const updated = service.update(
      created.id,
      { content: "Second instructions.", version: "1.0.0" },
      "admin",
    );
    expect(updated?.version).toBe("1.0.1");
    const versions = service.versions(created.id);
    expect(versions.map((version) => version.version)).toEqual(["1.0.1", "1.0.0"]);
    const enabled = service.enable(created.id, "admin");
    expect(enabled.status).toBe("enabled");
  });

  it("does not allow editing bundled skills", () => {
    const service = setup();
    const created = service.create(
      { name: "custom", description: "Custom", content: "Instructions." },
      "admin",
    );
    const reposDb = dbs[0]!;
    reposDb
      .prepare("UPDATE skills SET source = 'bundled' WHERE id = ?")
      .run(created.id);
    expect(() =>
      service.update(created.id, { content: "Changed." }, "admin"),
    ).toThrow(/Bundled skills cannot be edited/);
  });
});
