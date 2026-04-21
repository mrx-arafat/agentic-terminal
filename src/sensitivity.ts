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
  if (input.tool.startsWith("mcp__")) {
    return { level: "dangerous", reason: "mcp external call" };
  }
  if (["read_file", "read_all", "list_dir", "grep", "glob", "cd", "bg_list", "bg_logs"].includes(input.tool)) {
    return { level: "safe" };
  }
  if (input.tool === "bg_stop") {
    return { level: "dangerous", reason: "bg_stop" };
  }
  if (["write_file", "edit_file", "multi_edit", "create_dir", "move_path", "copy_path"].includes(input.tool)) {
    return { level: "dangerous", reason: input.tool };
  }
  if (input.tool === "delete_file") {
    return { level: "destructive", reason: "delete_file" };
  }
  if (input.tool === "delete_dir") {
    const recursive = input.args.recursive === true;
    return { level: "destructive", reason: recursive ? "delete_dir recursive" : "delete_dir" };
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
