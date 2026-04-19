import { describe, it, expect } from "vitest";
import { matchesSkill, rankSkills } from "../../src/skills/trigger.js";
import type { Skill } from "../../src/skills/types.js";

function makeSkill(name: string, patterns: string[]): Skill {
  return {
    metadata: { name, description: "", triggerPatterns: patterns },
    dir: "/fake",
    skillPath: "/fake/SKILL.md",
    body: "",
  };
}

describe("matchesSkill", () => {
  it("matches simple literal pattern", () => {
    const skill = makeSkill("fix", ["fix error"]);
    expect(matchesSkill("fix error in my code", skill)).toBe(true);
  });

  it("is case-insensitive", () => {
    const skill = makeSkill("fix", ["Fix Error"]);
    expect(matchesSkill("fix error please", skill)).toBe(true);
  });

  it("matches regex pattern", () => {
    const skill = makeSkill("fix", ["type.*error"]);
    expect(matchesSkill("I have a type mismatch error", skill)).toBe(true);
  });

  it("returns false when no pattern matches", () => {
    const skill = makeSkill("fix", ["database", "sql"]);
    expect(matchesSkill("fix my typescript error", skill)).toBe(false);
  });

  it("matches partial string (substring)", () => {
    const skill = makeSkill("deploy", ["deploy"]);
    expect(matchesSkill("can you deploy my app to prod?", skill)).toBe(true);
  });

  it("handles invalid regex gracefully (treats as literal)", () => {
    const skill = makeSkill("fix", ["(unclosed"]);
    // Should not throw — falls back to literal match
    expect(() => matchesSkill("anything", skill)).not.toThrow();
  });
});

describe("rankSkills", () => {
  it("returns skills that match sorted by pattern specificity", () => {
    const general = makeSkill("general", ["error"]);
    const specific = makeSkill("specific", ["typescript.*error"]);
    const unrelated = makeSkill("unrelated", ["deploy to aws"]);

    const ranked = rankSkills("typescript compilation error", [
      general,
      specific,
      unrelated,
    ]);

    expect(ranked).toHaveLength(2);
    expect(ranked[0].metadata.name).toBe("specific");
  });

  it("returns empty array when nothing matches", () => {
    const skill = makeSkill("deploy", ["deploy"]);
    const ranked = rankSkills("fix my bug", [skill]);
    expect(ranked).toEqual([]);
  });

  it("returns all matching skills", () => {
    const a = makeSkill("a", ["error"]);
    const b = makeSkill("b", ["error"]);
    const ranked = rankSkills("error occurred", [a, b]);
    expect(ranked).toHaveLength(2);
  });
});
