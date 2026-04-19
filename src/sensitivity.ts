export type Sensitivity = "safe" | "dangerous" | "destructive";

export interface ClassifyInput {
  tool: string;
  args: Record<string, unknown>;
}

const DESTRUCTIVE_BASH = [
  /\brm\s+-[a-zA-Z]*r[a-zA-Z]*f/,
  /\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/,
  /\b(mkfs|dd\s+.*of=|wipefs)\b/,
  /\bgit\s+push\s+.*--force\b/,
  /\bgit\s+push\s+-f\b/,
  /\bgit\s+push\s+--force-with-lease\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-zA-Z]*[fd]/,
  /\bchmod\s+-R?\s*0?777\b/,
  /\bcurl\s+[^|]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /\bwget\s+[^|]*\|\s*(sudo\s+)?(ba)?sh\b/,
  /\bDROP\s+(TABLE|DATABASE|SCHEMA)\b/i,
  /\bTRUNCATE\s+TABLE\b/i,
  />\s*\/dev\/sd[a-z]/,
  /:\(\)\{/
];

const DANGEROUS_BASH = [
  /\bsudo\b/,
  /\bssh\s+/,
  /\bscp\s+/,
  /\bsu\s+-?/,
  /\bapt(-get)?\s+(install|remove|purge)\b/,
  /\bbrew\s+(uninstall|reinstall|untap)\b/,
  /\bnpm\s+(publish|unpublish|adduser|token)\b/,
  /\bcurl\s+-X\s*(POST|PUT|DELETE|PATCH)\b/,
  /\bkill\s+-9\b/,
  /\bpkill\b/,
  /\bmv\s+.*\/(etc|usr|var|boot|bin|sbin)\//
];

export function classify(input: ClassifyInput): { level: Sensitivity; reason?: string } {
  if (["read_file", "list_dir", "grep", "glob", "cd"].includes(input.tool)) {
    return { level: "safe" };
  }
  if (["write_file", "edit_file"].includes(input.tool)) {
    return { level: "dangerous", reason: input.tool };
  }

  if (input.tool === "bash") {
    const cmd = String(input.args.command || "");
    for (const r of DESTRUCTIVE_BASH) {
      if (r.test(cmd)) return { level: "destructive", reason: r.source };
    }
    for (const r of DANGEROUS_BASH) {
      if (r.test(cmd)) return { level: "dangerous", reason: r.source };
    }
    return { level: "dangerous", reason: "bash" };
  }

  return { level: "safe" };
}

export const __TEST_CASES__ = [
  { input: { tool: "bash", args: { command: "rm -rf foo" } }, expected: "destructive" },
  { input: { tool: "bash", args: { command: "sudo apt update" } }, expected: "dangerous" },
  { input: { tool: "read_file", args: { path: "x" } }, expected: "safe" },
  { input: { tool: "bash", args: { command: "ls -la" } }, expected: "dangerous" },
  { input: { tool: "bash", args: { command: "DROP TABLE users" } }, expected: "destructive" },
  { input: { tool: "bash", args: { command: "chmod -R 777 ." } }, expected: "destructive" },
  { input: { tool: "bash", args: { command: "kill -9 123" } }, expected: "dangerous" },
  { input: { tool: "write_file", args: { path: "x" } }, expected: "dangerous" },
  { input: { tool: "cd", args: { dest: ".." } }, expected: "safe" },
  { input: { tool: "bash", args: { command: "curl -X POST url" } }, expected: "dangerous" }
];
