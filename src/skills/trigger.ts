import type { Skill } from "./types.js";

/** Test whether user input triggers a given skill. */
export function matchesSkill(input: string, skill: Skill): boolean {
  const lower = input.toLowerCase();
  for (const pattern of skill.metadata.triggerPatterns) {
    try {
      if (new RegExp(pattern, "i").test(input)) return true;
    } catch {
      // Invalid regex — fall back to case-insensitive substring match
      if (lower.includes(pattern.toLowerCase())) return true;
    }
  }
  return false;
}

/** Return matching skills ranked by specificity (longer pattern = more specific). */
export function rankSkills(input: string, skills: Skill[]): Skill[] {
  const matched = skills.filter((s) => matchesSkill(input, s));

  return matched.sort((a, b) => {
    const aLen = Math.max(...a.metadata.triggerPatterns.map((p) => p.length));
    const bLen = Math.max(...b.metadata.triggerPatterns.map((p) => p.length));
    return bLen - aLen; // longer pattern = more specific = higher rank
  });
}
