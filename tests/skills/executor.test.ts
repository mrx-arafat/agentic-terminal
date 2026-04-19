import { describe, it, expect } from "vitest";
import { buildSkillSystemPrompt, listSkillScripts } from "../../src/skills/executor.js";
import type { Skill } from "../../src/skills/types.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    metadata: {
      name: "fix-errors",
      description: "Fix errors automatically",
      triggerPatterns: ["fix error"],
    },
    dir: "/fake",
    skillPath: "/fake/SKILL.md",
    body: "# Fix Errors\n\nWhen you see an error, fix it step by step.",
    ...overrides,
  };
}

describe("buildSkillSystemPrompt", () => {
  it("includes skill name and body in prompt", () => {
    const skill = makeSkill();
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).toContain("fix-errors");
    expect(prompt).toContain("# Fix Errors");
  });

  it("mentions scripts dir when present", () => {
    const skill = makeSkill({ scriptsDir: "/fake/scripts" });
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).toContain("scripts");
  });

  it("does not mention scripts when none", () => {
    const skill = makeSkill({ scriptsDir: undefined });
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).not.toContain("scripts");
  });

  it("includes references hint when referencesDir present", () => {
    const skill = makeSkill({ referencesDir: "/fake/references" });
    const prompt = buildSkillSystemPrompt(skill);
    expect(prompt).toContain("references");
  });
});

describe("listSkillScripts", () => {
  let tmpDir: string;

  it("returns empty array when scriptsDir is undefined", () => {
    const scripts = listSkillScripts(undefined);
    expect(scripts).toEqual([]);
  });

  it("returns empty array when scripts dir does not exist", () => {
    const scripts = listSkillScripts("/nonexistent/scripts");
    expect(scripts).toEqual([]);
  });

  it("lists scripts from scriptsDir", () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-scripts-"));
    fs.writeFileSync(path.join(tmpDir, "fix.py"), "print('fix')");
    fs.writeFileSync(path.join(tmpDir, "validate.sh"), "#!/bin/sh");

    const scripts = listSkillScripts(tmpDir);
    expect(scripts).toHaveLength(2);
    expect(scripts.some((s) => s.endsWith("fix.py"))).toBe(true);
    expect(scripts.some((s) => s.endsWith("validate.sh"))).toBe(true);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
