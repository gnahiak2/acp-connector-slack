import type { SkillRecord } from "@slackboard/shared";
import { newId } from "@slackboard/shared";
import {
  bumpPatchVersion,
  loadBundledSkills,
  normalizeSkillInput,
  slugifySkill,
  type SkillReference,
} from "@slackboard/skills";
import type { Repositories } from "../db/index.js";
import type { AuditService } from "./audit.js";

export class SkillValidationError extends Error {}
export class SkillNotFoundError extends Error {}

export class SkillService {
  constructor(
    private readonly repos: Repositories,
    private readonly audit: AuditService,
    private readonly skillsRoot: string,
    private readonly maxBytes: number,
  ) {}

  async seedBundled(): Promise<void> {
    let bundled;
    try {
      bundled = await loadBundledSkills(this.skillsRoot, this.maxBytes);
    } catch {
      return;
    }
    const now = new Date().toISOString();
    for (const item of bundled) {
      this.repos.skills.seedBundled(
        {
          id: newId("skill"),
          name: item.skill.name,
          slug: item.skill.slug,
          description: item.skill.description,
          version: item.skill.version,
          content: item.skill.content,
          references: item.skill.references,
          status: "enabled",
          source: "bundled",
          createdBy: "system",
        },
        now,
      );
    }
  }

  list(): SkillRecord[] {
    return this.repos.skills.list();
  }

  get(id: string): SkillRecord {
    const skill = this.repos.skills.byId(id);
    if (!skill) throw new SkillNotFoundError("Skill not found");
    return skill;
  }

  create(
    input: {
      name: string;
      description: string;
      version?: string;
      content: string;
      references?: SkillReference[];
    },
    actor: string,
    options: { enable?: boolean } = {},
  ): SkillRecord {
    const parsed = normalizeSkillInput(input, this.maxBytes);
    if (this.repos.skills.bySlug(parsed.slug)) {
      throw new SkillValidationError(`A skill with slug ${parsed.slug} already exists`);
    }
    const skill = this.repos.skills.create(
      {
        id: newId("skill"),
        name: parsed.name,
        slug: parsed.slug,
        description: parsed.description,
        version: parsed.version,
        content: parsed.content,
        references: parsed.references,
        status: options.enable ? "enabled" : "draft",
        source: "custom",
        createdBy: actor,
      },
      new Date().toISOString(),
    );
    this.audit.record({
      actor,
      action: options.enable ? "skill.created_enabled" : "skill.draft_created",
      targetType: "skill",
      targetId: skill.id,
      detail: { slug: skill.slug, version: skill.version },
    });
    return skill;
  }

  update(
    id: string,
    input: {
      name?: string;
      description?: string;
      content?: string;
      version?: string;
      references?: SkillReference[];
    },
    actor: string,
  ): SkillRecord {
    const current = this.get(id);
    if (current.source === "bundled") {
      throw new SkillValidationError("Bundled skills cannot be edited; create a custom skill");
    }
    const nextVersion =
      input.version && input.version !== current.version
        ? input.version
        : bumpPatchVersion(current.version);
    const parsed = normalizeSkillInput(
      {
        name: input.name ?? current.name,
        description: input.description ?? current.description,
        version: nextVersion,
        content: input.content ?? current.content,
        references: input.references ?? current.references,
      },
      this.maxBytes,
    );
    const slugOwner = this.repos.skills.bySlug(parsed.slug);
    if (slugOwner && slugOwner.id !== id) {
      throw new SkillValidationError(`A skill with slug ${parsed.slug} already exists`);
    }
    const updated = this.repos.skills.update(
      id,
      {
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        content: parsed.content,
        references: parsed.references,
      },
      new Date().toISOString(),
    )!;
    this.audit.record({
      actor,
      action: "skill.versioned",
      targetType: "skill",
      targetId: id,
      detail: { version: parsed.version },
    });
    return updated;
  }

  enable(id: string, actor: string): SkillRecord {
    const skill = this.get(id);
    if (skill.status === "enabled") return skill;
    const updated = this.repos.skills.setStatus(id, "enabled", new Date().toISOString())!;
    this.audit.record({
      actor,
      action: "skill.enabled",
      targetType: "skill",
      targetId: id,
      detail: { version: skill.version },
    });
    return updated;
  }

  disable(id: string, actor: string): SkillRecord {
    const skill = this.get(id);
    const updated = this.repos.skills.setStatus(id, "disabled", new Date().toISOString())!;
    this.audit.record({
      actor,
      action: "skill.disabled",
      targetType: "skill",
      targetId: id,
      detail: { version: skill.version },
    });
    return updated;
  }

  versions(id: string): Array<{ version: string; createdAt: string; createdBy: string }> {
    this.get(id);
    return this.repos.skills.versions(id);
  }

  attach(sessionId: string, skillId: string, actor: string): void {
    if (!this.repos.sessions.byId(sessionId)) throw new SkillNotFoundError("Session not found");
    const skill = this.get(skillId);
    if (skill.status !== "enabled") throw new SkillValidationError("Skill is not enabled");
    this.repos.skills.attach(sessionId, skillId, new Date().toISOString());
    this.audit.record({
      actor,
      action: "skill.attached",
      targetType: "session",
      targetId: sessionId,
      detail: { skillId, version: skill.version },
    });
  }

  detach(sessionId: string, skillId: string, actor: string): void {
    this.repos.skills.detach(sessionId, skillId);
    this.audit.record({
      actor,
      action: "skill.detached",
      targetType: "session",
      targetId: sessionId,
      detail: { skillId },
    });
  }

  withSlug(slug: string): SkillRecord | undefined {
    return this.repos.skills.bySlug(slugifySkill(slug));
  }
}
