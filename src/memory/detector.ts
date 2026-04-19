import fs from "node:fs";
import path from "node:path";
import type { ProjectType } from "./types.js";

const SIGNALS: Array<{ file: string; type: ProjectType }> = [
  { file: "package.json", type: "node" },
  { file: "pyproject.toml", type: "python" },
  { file: "requirements.txt", type: "python" },
  { file: "setup.py", type: "python" },
  { file: "go.mod", type: "go" },
  { file: "Cargo.toml", type: "rust" },
  { file: "pom.xml", type: "java" },
  { file: "build.gradle", type: "java" },
  { file: "composer.json", type: "php" },
  { file: "Gemfile", type: "ruby" },
];

/** Detect project type from marker files in a directory. */
export function detectProjectType(cwd: string): ProjectType {
  for (const { file, type } of SIGNALS) {
    if (fs.existsSync(path.join(cwd, file))) return type;
  }
  return "unknown";
}

/** Get a stable project name for memory storage. */
export function getProjectName(cwd: string): string {
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: string };
      if (pkg.name) return sanitizeName(pkg.name);
    } catch {
      // fall through
    }
  }
  return sanitizeName(path.basename(cwd));
}

function sanitizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "project";
}
