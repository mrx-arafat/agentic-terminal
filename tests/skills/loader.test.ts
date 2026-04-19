import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { loadSkills, parseSkillMetadata } from "../../src/skills/loader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeSkill(dir: string, name: string, content: string): void {
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);
}

const validSkill = `---
name: fix-errors
description: Fix common errors automatically
trigger_patterns:
  - "fix error"
  - "type.*error"
---

# Fix Errors

When you see an error, fix it.
`;

const minimalSkill = `---
name: minimal
description: A minimal skill
trigger_patterns:
  - "minimal"
---

Body here.
`;

describe("parseSkillMetadata", () => {
  it("parses name, description, trigger_patterns", () => {
    const { metadata } = parseSkillMetadata(validSkill);
    expect(metadata.name).toBe("fix-errors");
    expect(metadata.description).toBe("Fix common errors automatically");
    expect(metadata.triggerPatterns).toEqual(["fix error", "type.*error"]);
  });

  it("returns body without frontmatter", () => {
    const { body } = parseSkillMetadata(validSkill);
    expect(body).toContain("# Fix Errors");
    expect(body).not.toContain("---");
  });

  it("throws when name is missing", () => {
    const bad = `---\ndescription: no name\ntrigger_patterns:\n  - "x"\n---\nbody`;
    expect(() => parseSkillMetadata(bad)).toThrow("name");
  });

  it("throws when trigger_patterns is empty", () => {
    const bad = `---\nname: test\ndescription: hi\ntrigger_patterns: []\n---\nbody`;
    expect(() => parseSkillMetadata(bad)).toThrow("trigger_patterns");
  });

  it("handles optional mcp field", () => {
    const withMcp = `---\nname: figma\ndescription: Figma skill\ntrigger_patterns:\n  - "figma"\nmcp: figma-server\n---\nbody`;
    const result = parseSkillMetadata(withMcp);
    expect(result.metadata.mcp).toBe("figma-server");
  });
});

describe("loadSkills", () => {
  it("returns empty array when directory does not exist", async () => {
    const skills = await loadSkills("/nonexistent/path");
    expect(skills).toEqual([]);
  });

  it("loads a valid skill", async () => {
    writeSkill(tmpDir, "fix-errors", validSkill);
    const skills = await loadSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].metadata.name).toBe("fix-errors");
  });

  it("loads multiple skills", async () => {
    writeSkill(tmpDir, "fix-errors", validSkill);
    writeSkill(tmpDir, "minimal", minimalSkill);
    const skills = await loadSkills(tmpDir);
    expect(skills).toHaveLength(2);
  });

  it("skips directory with no SKILL.md", async () => {
    fs.mkdirSync(path.join(tmpDir, "no-skill-file"));
    writeSkill(tmpDir, "fix-errors", validSkill);
    const skills = await loadSkills(tmpDir);
    expect(skills).toHaveLength(1);
  });

  it("skips invalid SKILL.md and loads valid ones", async () => {
    writeSkill(tmpDir, "bad", `---\ndescription: no name\n---\nbody`);
    writeSkill(tmpDir, "good", validSkill);
    const skills = await loadSkills(tmpDir);
    expect(skills).toHaveLength(1);
    expect(skills[0].metadata.name).toBe("fix-errors");
  });

  it("detects scriptsDir when scripts/ exists", async () => {
    writeSkill(tmpDir, "with-scripts", validSkill);
    fs.mkdirSync(path.join(tmpDir, "with-scripts", "scripts"));
    const skills = await loadSkills(tmpDir);
    expect(skills[0].scriptsDir).toBeDefined();
  });

  it("detects referencesDir when references/ exists", async () => {
    writeSkill(tmpDir, "with-refs", validSkill);
    fs.mkdirSync(path.join(tmpDir, "with-refs", "references"));
    const skills = await loadSkills(tmpDir);
    expect(skills[0].referencesDir).toBeDefined();
  });

  it("stores skill body without frontmatter", async () => {
    writeSkill(tmpDir, "fix-errors", validSkill);
    const skills = await loadSkills(tmpDir);
    expect(skills[0].body).toContain("# Fix Errors");
    expect(skills[0].body).not.toContain("trigger_patterns");
  });
});

describe("loadSkills — project + global merge", () => {
  it("project skills override global by name", async () => {
    const globalDir = path.join(tmpDir, "global");
    const projectDir = path.join(tmpDir, "project");
    fs.mkdirSync(globalDir);
    fs.mkdirSync(projectDir);

    const globalVersion = validSkill.replace(
      "Fix common errors automatically",
      "Global version"
    );
    const projectVersion = validSkill.replace(
      "Fix common errors automatically",
      "Project version"
    );

    writeSkill(globalDir, "fix-errors", globalVersion);
    writeSkill(projectDir, "fix-errors", projectVersion);
    writeSkill(globalDir, "global-only", minimalSkill);

    const { mergeSkills } = await import("../../src/skills/loader.js");
    const global = await loadSkills(globalDir);
    const project = await loadSkills(projectDir);
    const merged = mergeSkills(global, project);

    expect(merged).toHaveLength(2);
    const fixErrors = merged.find((s) => s.metadata.name === "fix-errors")!;
    expect(fixErrors.metadata.description).toBe("Project version");
  });
});
