import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { needsPty, runInteractive } from "./pty.js";

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  dangerous: boolean;
}

export interface ToolContext {
  cwd: string;
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>;

const MAX_OUTPUT = 20000;

function truncate(s: string): string {
  if (s.length <= MAX_OUTPUT) return s;
  return s.slice(0, MAX_OUTPUT) + `\n\n[truncated ${s.length - MAX_OUTPUT} chars]`;
}

function resolveInside(cwd: string, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(cwd, p);
}

async function bash(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const command = String(args.command ?? "");
  let timeout = Number(args.timeout ?? 120000);
  if (!command) return "error: command required";

  if (needsPty(command)) {
    if (!process.stdin.isTTY) {
      return "error: this command needs an interactive terminal; run it manually";
    }
    if (timeout === 120000) timeout = 300000;
    const res = await runInteractive({ command, cwd: ctx.cwd, timeoutMs: timeout });
    if (res.error) return `error: ${res.error}`;
    const parts: string[] = [`exit_code: ${res.exitCode}`];
    if (res.output) parts.push(`stdout:\n${res.output}`);
    return truncate(parts.join("\n"));
  }

  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd: ctx.cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += "\n[killed: timeout]";
    }, timeout);

    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { stderr += `\n[spawn error: ${e.message}]`; });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parts: string[] = [`exit_code: ${code ?? "?"}`];
      if (stdout) parts.push(`stdout:\n${stdout}`);
      if (stderr) parts.push(`stderr:\n${stderr}`);
      resolve(truncate(parts.join("\n")));
    });
  });
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  if (!p) return "error: path required";
  const abs = resolveInside(ctx.cwd, p);
  try {
    const content = await fs.readFile(abs, "utf8");
    return truncate(content);
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  const content = String(args.content ?? "");
  if (!p) return "error: path required";
  const abs = resolveInside(ctx.cwd, p);
  try {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return `ok: wrote ${content.length} bytes to ${abs}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  const oldStr = String(args.old_string ?? "");
  const newStr = String(args.new_string ?? "");
  if (!p || !oldStr) return "error: path and old_string required";
  const abs = resolveInside(ctx.cwd, p);
  try {
    const content = await fs.readFile(abs, "utf8");
    const idx = content.indexOf(oldStr);
    if (idx === -1) return "error: old_string not found in file";
    const count = content.split(oldStr).length - 1;
    if (count > 1) return `error: old_string matches ${count} times; make it unique`;
    const updated = content.replace(oldStr, newStr);
    await fs.writeFile(abs, updated, "utf8");
    return `ok: replaced 1 occurrence in ${abs}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function listDir(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? ".");
  const abs = resolveInside(ctx.cwd, p);
  try {
    const entries = await fs.readdir(abs, { withFileTypes: true });
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return truncate(lines.join("\n") || "(empty)");
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function grep(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = String(args.pattern ?? "");
  const dir = String(args.path ?? ".");
  if (!pattern) return "error: pattern required";
  const flags = [
    "-rEn",
    "--color=never",
    "--exclude-dir=node_modules",
    "--exclude-dir=.git",
    "--exclude-dir=dist",
    "--exclude-dir=build",
  ];
  const cmd = `grep ${flags.join(" ")} -- ${JSON.stringify(pattern)} ${JSON.stringify(dir)} | head -n 200`;
  return bash({ command: cmd, timeout: 30000 }, ctx);
}

async function glob(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = String(args.pattern ?? "");
  if (!pattern) return "error: pattern required";
  const cmd = `find . -type f -name ${JSON.stringify(pattern)} -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' | head -n 200`;
  return bash({ command: cmd, timeout: 30000 }, ctx);
}

async function createDir(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  if (!p) return "error: path required";
  const abs = resolveInside(ctx.cwd, p);
  try {
    await fs.mkdir(abs, { recursive: true });
    return `ok: created ${abs}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function deleteFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  if (!p) return "error: path required";
  const abs = resolveInside(ctx.cwd, p);
  try {
    const stat = await fs.stat(abs);
    if (stat.isDirectory()) return "error: path is a directory; use delete_dir";
    await fs.unlink(abs);
    return `ok: deleted ${abs}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function deleteDir(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  const recursive = args.recursive === true;
  if (!p) return "error: path required";
  const abs = resolveInside(ctx.cwd, p);
  if (abs === "/" || abs === path.parse(abs).root) return "error: refusing to delete filesystem root";
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return "error: path is not a directory";
    if (recursive) {
      await fs.rm(abs, { recursive: true, force: false });
    } else {
      await fs.rmdir(abs);
    }
    return `ok: removed ${abs}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function movePath(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const from = String(args.from ?? "");
  const to = String(args.to ?? "");
  if (!from || !to) return "error: from and to required";
  const src = resolveInside(ctx.cwd, from);
  const dst = resolveInside(ctx.cwd, to);
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(src, dst);
    return `ok: moved ${src} -> ${dst}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function copyPath(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const from = String(args.from ?? "");
  const to = String(args.to ?? "");
  if (!from || !to) return "error: from and to required";
  const src = resolveInside(ctx.cwd, from);
  const dst = resolveInside(ctx.cwd, to);
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.cp(src, dst, { recursive: true, force: false, errorOnExist: true });
    return `ok: copied ${src} -> ${dst}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function multiEdit(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  const edits = args.edits;
  if (!p) return "error: path required";
  if (!Array.isArray(edits) || edits.length === 0) return "error: edits array required (non-empty)";
  const abs = resolveInside(ctx.cwd, p);
  try {
    let content = await fs.readFile(abs, "utf8");
    let applied = 0;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] as { old_string?: unknown; new_string?: unknown };
      const oldStr = String(e?.old_string ?? "");
      const newStr = String(e?.new_string ?? "");
      if (!oldStr) return `error: edit #${i + 1} missing old_string`;
      const idx = content.indexOf(oldStr);
      if (idx === -1) return `error: edit #${i + 1} old_string not found`;
      const count = content.split(oldStr).length - 1;
      if (count > 1) return `error: edit #${i + 1} old_string matches ${count} times; make it unique`;
      content = content.replace(oldStr, newStr);
      applied++;
    }
    await fs.writeFile(abs, content, "utf8");
    return `ok: applied ${applied} edit(s) to ${abs}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function cd(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  if (!p) return `cwd: ${ctx.cwd}`;
  const abs = resolveInside(ctx.cwd, p);
  try {
    const stat = await fs.stat(abs);
    if (!stat.isDirectory()) return "error: not a directory";
    ctx.cwd = abs;
    return `ok: cwd now ${abs}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "bash",
    description:
      "Run a shell command in the current working directory. Use for git, npm, grep, curl, system inspection, package managers, etc. Returns exit_code, stdout, stderr.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in ms (default 120000)" },
      },
      required: ["command"],
    },
    dangerous: true,
  },
  {
    name: "read_file",
    description: "Read contents of a file. Path can be relative to cwd or absolute.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    dangerous: false,
  },
  {
    name: "write_file",
    description: "Write (or overwrite) a file with the given content. Creates parent dirs if missing.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
    dangerous: true,
  },
  {
    name: "edit_file",
    description:
      "Replace exactly one occurrence of old_string with new_string in the given file. Fails if old_string is missing or not unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
    },
    dangerous: true,
  },
  {
    name: "list_dir",
    description: "List entries in a directory. Default path is current cwd.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
    },
    dangerous: false,
  },
  {
    name: "grep",
    description: "Recursive regex search across files in a directory (skips node_modules, .git, dist, build).",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Extended regex pattern" },
        path: { type: "string", description: "Directory to search (default .)" },
      },
      required: ["pattern"],
    },
    dangerous: false,
  },
  {
    name: "glob",
    description: "Find files by name pattern (e.g. '*.ts'). Skips node_modules, .git, dist.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" } },
      required: ["pattern"],
    },
    dangerous: false,
  },
  {
    name: "cd",
    description: "Change the session's working directory. Future tool calls use the new cwd.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    dangerous: false,
  },
  {
    name: "create_dir",
    description: "Create a directory (and any missing parents). Idempotent — succeeds if it already exists.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    dangerous: true,
  },
  {
    name: "delete_file",
    description: "Delete a single file. Fails on directories — use delete_dir for those.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
    dangerous: true,
  },
  {
    name: "delete_dir",
    description: "Delete a directory. Pass recursive=true to remove non-empty dirs. Refuses filesystem root.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean", description: "Remove recursively (default false)" },
      },
      required: ["path"],
    },
    dangerous: true,
  },
  {
    name: "move_path",
    description: "Move or rename a file or directory. Creates missing parent dirs at destination.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["from", "to"],
    },
    dangerous: true,
  },
  {
    name: "copy_path",
    description: "Copy a file or directory (recursive). Fails if destination exists.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string" },
        to: { type: "string" },
      },
      required: ["from", "to"],
    },
    dangerous: true,
  },
  {
    name: "multi_edit",
    description:
      "Apply multiple unique old_string/new_string replacements to one file atomically. Fails (no writes) if any old_string is missing or non-unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              old_string: { type: "string" },
              new_string: { type: "string" },
            },
            required: ["old_string", "new_string"],
          },
        },
      },
      required: ["path", "edits"],
    },
    dangerous: true,
  },
];

export const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash,
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  list_dir: listDir,
  grep,
  glob,
  cd,
  create_dir: createDir,
  delete_file: deleteFile,
  delete_dir: deleteDir,
  move_path: movePath,
  copy_path: copyPath,
  multi_edit: multiEdit,
};

export function findTool(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}
