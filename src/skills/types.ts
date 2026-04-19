export interface SkillMetadata {
  name: string;
  description: string;
  triggerPatterns: string[];
  mcp?: string;
}

export interface Skill {
  metadata: SkillMetadata;
  /** Directory containing this skill */
  dir: string;
  /** Path to SKILL.md */
  skillPath: string;
  /** Skill body (SKILL.md without frontmatter) */
  body: string;
  /** Path to scripts/ dir if it exists */
  scriptsDir?: string;
  /** Path to references/ dir if it exists */
  referencesDir?: string;
}

export interface SkillExecution {
  skillName: string;
  triggeredBy: string;
  startedAt: number;
  endedAt?: number;
  successful?: boolean;
  scriptsRun: string[];
  referencesLoaded: string[];
}
