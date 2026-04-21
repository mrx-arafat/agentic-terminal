import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Return the closest directory-name match for `needle` under `base`, or undefined. */
export function suggestDir(base: string, needle: string): string | undefined {
  try {
    const entries = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map((e) => e.name);
    const lower = needle.toLowerCase();
    const starts = entries.find((n) => n.toLowerCase().startsWith(lower));
    if (starts) return starts;
    return entries.find((n) => n.toLowerCase().includes(lower));
  } catch {
    return undefined;
  }
}

/** readline completer: completes the last whitespace-separated token of `line` as a path. */
export function buildCompletions(line: string, cwd: string): [string[], string] {
  const m = line.match(/(\S*)$/);
  const token = m ? m[1] : "";
  const firstToken = line.trimStart().split(/\s+/)[0];
  const dirOnly = firstToken === "cd" || firstToken === "pushd" || firstToken === "!cd";

  const expanded = expandTilde(token);
  const absolute = path.isAbsolute(expanded);
  const baseDir = absolute
    ? (expanded.endsWith(path.sep) ? expanded : path.dirname(expanded) || path.sep)
    : path.resolve(cwd, expanded.endsWith(path.sep) ? expanded : path.dirname(expanded) || ".");
  const prefix = expanded.endsWith(path.sep) ? "" : path.basename(expanded);

  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return [[], token];
  }

  const matches = entries
    .filter((e) => e.name.startsWith(prefix))
    .filter((e) => !dirOnly || e.isDirectory() || e.isSymbolicLink())
    .filter((e) => prefix.startsWith(".") || !e.name.startsWith("."))
    .map((e) => {
      const displayName = e.name + (e.isDirectory() ? "/" : "");
      const head =
        expanded.endsWith(path.sep)
          ? expanded
          : path.dirname(expanded) === "." && !expanded.includes(path.sep)
            ? ""
            : path.dirname(expanded) + path.sep;
      const tokenHead = token.startsWith("~/")
        ? token.slice(0, token.lastIndexOf("/") + 1)
        : head;
      return tokenHead + displayName;
    })
    .sort((a, b) => a.localeCompare(b));

  return [matches, token];
}
