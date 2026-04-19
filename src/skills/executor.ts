import fs from "node:fs";
import path from "node:path";
import type { Skill, SkillExecution } from "./types.js";

/** Build the system-prompt fragment injected when a skill is active. */
export function buildSkillSystemPrompt(skill: Skill): string {
  const lines: string[] = [
    `## Active Skill: ${skill.metadata.name}`,
    ``,
    `The following skill is active for this request. Follow its instructions carefully.`,
    ``,
    skill.body,
  ];

  if (skill.scriptsDir) {
    lines.push(``);
    lines.push(`### Skill scripts directory: ${skill.scriptsDir}`);
    const scripts = listSkillScripts(skill.scriptsDir);
    for (const s of scripts) {
      lines.push(`- ${path.basename(s)}`);
    }
    lines.push(`Run scripts with the bash tool when the skill instructs it.`);
  }

  if (skill.referencesDir) {
    lines.push(``);
    lines.push(
      `### Reference documents available in: ${skill.referencesDir}`,
    );
    lines.push(
      `Use read_file to load a reference when you need detailed information from it.`,
    );
  }

  return lines.join("\n");
}

/** List all files in a skill's scripts directory. */
export function listSkillScripts(scriptsDir: string | undefined): string[] {
  if (!scriptsDir || !fs.existsSync(scriptsDir)) return [];
  return fs
    .readdirSync(scriptsDir)
    .filter((f) => !f.startsWith("."))
    .map((f) => path.join(scriptsDir, f));
}

/** Create an execution record for tracking skill runs. */
export function startSkillExecution(
  skill: Skill,
  triggeredBy: string,
): SkillExecution {
  return {
    skillName: skill.metadata.name,
    triggeredBy,
    startedAt: Date.now(),
    scriptsRun: [],
    referencesLoaded: [],
  };
}

/** Mark a skill execution as complete. */
export function finishSkillExecution(
  exec: SkillExecution,
  successful: boolean,
): SkillExecution {
  return { ...exec, endedAt: Date.now(), successful };
}
