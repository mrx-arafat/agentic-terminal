import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { detectProjectType } from "./memory/detector.js";
import type { ProjectType } from "./memory/types.js";

export interface SessionContext {
  cwd: string;
  projectType: ProjectType;
  gitBranch?: string;
  gitDirty?: { modified: number; untracked: number; staged: number };
  topEntries: string[];
  framework?: string;
  summary: string;
}

const FRAMEWORK_HINTS: Array<{ file: string; framework: string }> = [
  { file: "next.config.js", framework: "Next.js" },
  { file: "next.config.mjs", framework: "Next.js" },
  { file: "next.config.ts", framework: "Next.js" },
  { file: "nuxt.config.ts", framework: "Nuxt" },
  { file: "svelte.config.js", framework: "SvelteKit" },
  { file: "astro.config.mjs", framework: "Astro" },
  { file: "remix.config.js", framework: "Remix" },
  { file: "vite.config.ts", framework: "Vite" },
  { file: "vite.config.js", framework: "Vite" },
  { file: "angular.json", framework: "Angular" },
  { file: "manage.py", framework: "Django" },
  { file: "pyproject.toml", framework: "Python (pyproject)" },
  { file: "fastapi", framework: "FastAPI" },
];

function gitInfo(cwd: string): Partial<Pick<SessionContext, "gitBranch" | "gitDirty">> {
  try {
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000,
    });
    const lines = status.split("\n").filter((l) => l.length > 0);
    let modified = 0, untracked = 0, staged = 0;
    for (const l of lines) {
      const x = l[0];
      const y = l[1];
      if (x === "?" && y === "?") untracked++;
      else {
        if (x !== " " && x !== "?") staged++;
        if (y !== " " && y !== "?") modified++;
      }
    }
    return { gitBranch: branch, gitDirty: { modified, untracked, staged } };
  } catch {
    return {};
  }
}

function detectFramework(cwd: string): string | undefined {
  for (const { file, framework } of FRAMEWORK_HINTS) {
    if (fs.existsSync(path.join(cwd, file))) return framework;
  }
  const pkg = path.join(cwd, "package.json");
  if (fs.existsSync(pkg)) {
    try {
      const data = JSON.parse(fs.readFileSync(pkg, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = { ...(data.dependencies ?? {}), ...(data.devDependencies ?? {}) };
      if ("next" in deps) return "Next.js";
      if ("nuxt" in deps) return "Nuxt";
      if ("react" in deps) return "React";
      if ("vue" in deps) return "Vue";
      if ("svelte" in deps) return "Svelte";
      if ("express" in deps) return "Express";
      if ("fastify" in deps) return "Fastify";
    } catch { /* ignore */ }
  }
  return undefined;
}

export function buildSessionContext(cwd: string): SessionContext {
  const projectType = detectProjectType(cwd);
  const framework = detectFramework(cwd);
  let topEntries: string[] = [];
  try {
    topEntries = fs.readdirSync(cwd, { withFileTypes: true })
      .filter((d) => !d.name.startsWith("."))
      .slice(0, 25)
      .map((d) => d.isDirectory() ? `${d.name}/` : d.name);
  } catch { /* ignore */ }

  const git = gitInfo(cwd);
  const ctx: SessionContext = {
    cwd,
    projectType,
    topEntries,
    framework,
    ...git,
    summary: "",
  };
  ctx.summary = renderSummary(ctx);
  return ctx;
}

function renderSummary(c: SessionContext): string {
  const parts: string[] = [];
  parts.push(`## Project Context`);
  parts.push(`- Directory: ${c.cwd}`);
  if (c.projectType !== "unknown") parts.push(`- Project type: ${c.projectType}`);
  if (c.framework) parts.push(`- Framework: ${c.framework}`);
  if (c.gitBranch) {
    const d = c.gitDirty;
    const dirty = d
      ? (d.modified + d.untracked + d.staged === 0
          ? "clean"
          : `${d.modified} modified, ${d.staged} staged, ${d.untracked} untracked`)
      : "";
    parts.push(`- Git: branch=${c.gitBranch}${dirty ? `, ${dirty}` : ""}`);
  }
  if (c.topEntries.length > 0) {
    parts.push(`- Top entries: ${c.topEntries.slice(0, 20).join(", ")}`);
  }
  return parts.join("\n");
}
