import fs from "node:fs";
import path from "node:path";
import type { Skill, SkillMetadata } from "./types.js";

/** Parse SKILL.md content — extracts frontmatter + body. */
export function parseSkillMetadata(content: string): {
  metadata: SkillMetadata;
  body: string;
} {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error("SKILL.md missing YAML frontmatter (--- delimiters)");

  const [, yaml, body] = match;
  const metadata = parseYaml(yaml);

  if (!metadata.name) throw new Error("SKILL.md missing required field: name");
  if (!metadata.triggerPatterns?.length)
    throw new Error("SKILL.md missing required field: trigger_patterns (must have at least one)");

  return { metadata, body: body.trimStart() };
}

/** Load all skills from a directory. Invalid skills are skipped silently. */
export async function loadSkills(dir: string): Promise<Skill[]> {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const skillDir = path.join(dir, entry.name);
    const skillPath = path.join(skillDir, "SKILL.md");

    if (!fs.existsSync(skillPath)) continue;

    try {
      const content = fs.readFileSync(skillPath, "utf8");
      const { metadata, body } = parseSkillMetadata(content);

      const scriptsDir = path.join(skillDir, "scripts");
      const referencesDir = path.join(skillDir, "references");

      skills.push({
        metadata,
        dir: skillDir,
        skillPath,
        body,
        scriptsDir: fs.existsSync(scriptsDir) ? scriptsDir : undefined,
        referencesDir: fs.existsSync(referencesDir) ? referencesDir : undefined,
      });
    } catch {
      // Skip invalid skills without crashing
    }
  }

  return skills;
}

/** Merge global and project skills. Project skills override global by name. */
export function mergeSkills(global: Skill[], project: Skill[]): Skill[] {
  const map = new Map<string, Skill>();
  for (const s of global) map.set(s.metadata.name, s);
  for (const s of project) map.set(s.metadata.name, s); // project wins
  return Array.from(map.values());
}

// Minimal YAML parser for SKILL.md frontmatter (no external deps)
function parseYaml(yaml: string): SkillMetadata {
  const lines = yaml.split("\n");
  const result: Partial<SkillMetadata> & { trigger_patterns?: string[] } = {};
  let inTriggerPatterns = false;
  const patterns: string[] = [];

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.startsWith("trigger_patterns:")) {
      inTriggerPatterns = true;
      // Handle inline: trigger_patterns: ["a","b"]
      const inline = line.slice("trigger_patterns:".length).trim();
      if (inline && inline !== "[]") {
        const items = inline.replace(/^\[|\]$/g, "").split(",");
        for (const item of items) {
          const v = item.trim().replace(/^["']|["']$/g, "");
          if (v) patterns.push(v);
        }
        inTriggerPatterns = false;
      }
      continue;
    }

    if (inTriggerPatterns) {
      if (line.startsWith("  - ")) {
        patterns.push(line.slice(4).trim().replace(/^["']|["']$/g, ""));
        continue;
      } else if (!line.startsWith(" ") && line.includes(":")) {
        inTriggerPatterns = false;
      } else {
        continue;
      }
    }

    if (line.startsWith("name:")) {
      result.name = line.slice(5).trim().replace(/^["']|["']$/g, "");
    } else if (line.startsWith("description:")) {
      result.description = line.slice(12).trim().replace(/^["']|["']$/g, "");
    } else if (line.startsWith("mcp:")) {
      result.mcp = line.slice(4).trim().replace(/^["']|["']$/g, "");
    }
  }

  return {
    name: result.name ?? "",
    description: result.description ?? "",
    triggerPatterns: patterns,
    mcp: result.mcp,
  };
}
