import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { needsPty, runInteractive } from "./pty.js";
import type { BgProcess, BlockRecord, TodoItem } from "./blocks.js";

let RG_AVAILABLE: boolean | null = null;
function hasRg(): boolean {
  if (RG_AVAILABLE !== null) return RG_AVAILABLE;
  try {
    execFileSync("rg", ["--version"], { stdio: "ignore", timeout: 2000 });
    RG_AVAILABLE = true;
  } catch {
    RG_AVAILABLE = false;
  }
  return RG_AVAILABLE;
}

interface SpawnResult { stdout: string; stderr: string; exitCode: number | null }

function runCmd(cmd: string, args: string[], cwd: string, timeoutMs = 30000): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      stderr += "\n[killed: timeout]";
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => { stderr += `\n[spawn error: ${e.message}]`; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code });
    });
  });
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  dangerous: boolean;
}

export interface ToolContext {
  cwd: string;
  /** Absolute paths the LLM has read this session; used by edit-guard. */
  readPaths?: Set<string>;
  /** Bash command blocks recorded this session. */
  blocks?: BlockRecord[];
  /** Planning todos. */
  todos?: TodoItem[];
  /** Latest staged diff preview (set by preview_diff, consumed by approval UI). */
  pendingDiff?: { path: string; diff: string };
  /** Background processes started via bash(background=true). */
  bgProcs?: BgProcess[];
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

function numberLines(s: string, startAt = 1): string {
  const lines = s.split("\n");
  const width = Math.max(4, String(startAt + lines.length - 1).length);
  return lines
    .map((l, i) => `${String(startAt + i).padStart(width, " ")}\t${l}`)
    .join("\n");
}

function recordBlock(
  ctx: ToolContext,
  command: string,
  startedAt: number,
  exitCode: number | null,
  output: string,
): void {
  if (!ctx.blocks) return;
  const full = output;
  const truncated = full.length > MAX_OUTPUT;
  ctx.blocks.push({
    id: ctx.blocks.length,
    cwd: ctx.cwd,
    command,
    startedAt,
    durationMs: Date.now() - startedAt,
    exitCode,
    output: truncated ? full.slice(0, MAX_OUTPUT) : full,
    truncated,
  });
}

async function bash(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const command = String(args.command ?? "");
  let timeout = Number(args.timeout ?? 120000);
  const background = args.background === true;
  if (!command) return "error: command required";
  const startedAt = Date.now();

  if (background) {
    if (!ctx.bgProcs) ctx.bgProcs = [];
    const id = ctx.bgProcs.length;
    const bgDir = path.join(ctx.cwd, ".agentic", "bg");
    await fs.mkdir(bgDir, { recursive: true });
    const logPath = path.join(bgDir, `${id}.log`);
    const logFd = fsSync.openSync(logPath, "w");
    const child = spawn("bash", ["-lc", command], {
      cwd: ctx.cwd,
      stdio: ["ignore", logFd, logFd],
      detached: true,
    });
    child.unref();
    fsSync.closeSync(logFd);
    const pid = child.pid ?? -1;
    const proc: BgProcess = {
      id,
      pid,
      command,
      cwd: ctx.cwd,
      logPath,
      startedAt,
      status: "running",
      exitCode: null,
    };
    ctx.bgProcs.push(proc);
    child.on("exit", (code) => {
      proc.status = "exited";
      proc.exitCode = code;
    });
    child.on("error", (e) => {
      proc.status = "exited";
      proc.exitCode = -1;
      try { fsSync.appendFileSync(logPath, `\n[spawn error: ${e.message}]\n`); } catch { /* ignore */ }
    });
    return `ok: started bg id=${id} pid=${pid} logPath=${logPath}\ncommand: ${command}\nuse bg_logs id=${id} to read output, bg_stop id=${id} to stop`;
  }

  if (needsPty(command)) {
    if (!process.stdin.isTTY) {
      return "error: this command needs an interactive terminal; run it manually";
    }
    if (timeout === 120000) timeout = 300000;
    const res = await runInteractive({ command, cwd: ctx.cwd, timeoutMs: timeout });
    if (res.error) {
      recordBlock(ctx, command, startedAt, res.exitCode ?? null, res.error);
      return `error: ${res.error}`;
    }
    const parts: string[] = [`exit_code: ${res.exitCode}`];
    if (res.output) parts.push(`stdout:\n${res.output}`);
    const out = truncate(parts.join("\n"));
    recordBlock(ctx, command, startedAt, res.exitCode ?? null, res.output ?? "");
    return out;
  }

  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ctx.cwd,
      // Close stdin so scaffolders that use @clack/prompts / inquirer see EOF
      // immediately and honor the flags we pass, instead of aborting with
      // "Operation cancelled" when they detect a non-TTY readable stdin.
      stdio: ["ignore", "pipe", "pipe"],
    });
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
      const combined = (stdout + (stderr ? `\n[stderr]\n${stderr}` : "")).trimEnd();
      recordBlock(ctx, command, startedAt, code, combined);
      resolve(truncate(parts.join("\n")));
    });
  });
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  const offset = Number(args.offset ?? 0);
  const limit = args.limit !== undefined ? Number(args.limit) : undefined;
  if (!p) return "error: path required";
  const abs = resolveInside(ctx.cwd, p);
  try {
    const raw = await fs.readFile(abs, "utf8");
    ctx.readPaths?.add(abs);
    const lines = raw.split("\n");
    const start = Math.max(0, offset);
    const end = limit !== undefined ? Math.min(lines.length, start + limit) : lines.length;
    const slice = lines.slice(start, end).join("\n");
    const numbered = numberLines(slice, start + 1);
    const tail = end < lines.length ? `\n\n[… ${lines.length - end} more lines; call again with offset=${end}]` : "";
    return truncate(numbered + tail);
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

function requireReadFirst(ctx: ToolContext, abs: string): string | null {
  if (!ctx.readPaths) return null; // feature disabled (e.g., tests)
  if (ctx.readPaths.has(abs)) return null;
  return `error: must read_file("${path.relative(ctx.cwd, abs) || abs}") before editing; this prevents blind edits`;
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  const content = String(args.content ?? "");
  if (!p) return "error: path required";
  const abs = resolveInside(ctx.cwd, p);
  try {
    // only guard if file exists and hasn't been read
    let existed = false;
    try { await fs.access(abs); existed = true; } catch { /* new file */ }
    if (existed) {
      const guard = requireReadFirst(ctx, abs);
      if (guard) return guard;
    }
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    ctx.readPaths?.add(abs); // after write, contents are known
    return `ok: wrote ${content.length} bytes to ${abs}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const p = String(args.path ?? "");
  const oldStr = String(args.old_string ?? "");
  const newStr = String(args.new_string ?? "");
  if (!p) return "error: path required";
  const abs = resolveInside(ctx.cwd, p);

  // Auto-fallback: editing an empty/missing file with empty old_string is
  // really a write. Weak models often pick edit_file when they should use
  // write_file. Don't punish them with cryptic errors.
  let existing = "";
  let fileExists = false;
  try { existing = await fs.readFile(abs, "utf8"); fileExists = true; } catch { /* missing */ }
  if ((!fileExists || existing.length === 0) && newStr) {
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, newStr, "utf8");
    ctx.readPaths?.add(abs);
    return `ok: wrote ${newStr.length} bytes to ${abs} (edit_file on empty file — next time use write_file for new content)`;
  }
  if (!oldStr) {
    return "error: edit_file needs both old_string (what to find) and new_string (what to replace it with). To create a new file or fill an empty one, use write_file({ path, content }) instead.";
  }
  const guard = requireReadFirst(ctx, abs);
  if (guard) return guard;
  try {
    const idx = existing.indexOf(oldStr);
    if (idx === -1) return `error: old_string not found in ${p} — read_file the path first to see current content, then try again with exact text`;
    const count = existing.split(oldStr).length - 1;
    if (count > 1) return `error: old_string matches ${count} times; add more surrounding context to make it unique`;
    const updated = existing.replace(oldStr, newStr);
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
  const fileType = args.type ? String(args.type) : "";
  const glob = args.glob ? String(args.glob) : "";
  const ignoreCase = args.ignore_case === true;
  const context = args.context !== undefined ? Math.max(0, Number(args.context)) : 0;
  const maxCount = args.max_count !== undefined ? Math.max(1, Number(args.max_count)) : 200;
  if (!pattern) return "error: pattern required";

  if (hasRg()) {
    const rgArgs = ["--color=never", "-n", "--no-heading", "--max-filesize", "1M"];
    if (ignoreCase) rgArgs.push("-i"); else rgArgs.push("-S");
    if (fileType) rgArgs.push("-t", fileType);
    if (glob) rgArgs.push("-g", glob);
    if (context > 0) rgArgs.push("-C", String(context));
    rgArgs.push("-e", pattern, dir);
    const r = await runCmd("rg", rgArgs, ctx.cwd);
    // rg exit: 0=matches, 1=none, 2=error
    if (r.exitCode === 1) return `no matches for: ${pattern}`;
    if (r.exitCode === 2) return `error: ${r.stderr.trim() || "rg failed"}`;
    const cutLines = r.stdout.split("\n").filter((l) => l.length > 0);
    const fileCount = new Set(cutLines.map((l) => l.split(":")[0])).size;
    const shown = cutLines.slice(0, maxCount).join("\n");
    const tail = cutLines.length > maxCount ? `\n[… ${cutLines.length - maxCount} more matches]` : "";
    return truncate(`matches: ${cutLines.length} in ${fileCount} file(s)\n${shown}${tail}`);
  }

  // Fallback: GNU/BSD grep
  const flags: string[] = [];
  flags.push("-rEn", "--color=never");
  if (ignoreCase) flags.push("-i");
  for (const d of ["node_modules", ".git", "dist", "build", ".next", "target", "vendor"]) {
    flags.push(`--exclude-dir=${d}`);
  }
  if (context > 0) flags.push(`-C`, String(context));
  const cmd = `grep ${flags.join(" ")} -- ${JSON.stringify(pattern)} ${JSON.stringify(dir)} | head -n ${maxCount}`;
  const out = await bash({ command: cmd, timeout: 30000 }, ctx);
  if (out.includes("exit_code: 1") && !out.match(/stdout:\n\S/)) return `no matches for: ${pattern}`;
  return out;
}

async function glob(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const pattern = String(args.pattern ?? "");
  const includeHidden = args.hidden === true;
  const caseInsensitive = args.ignore_case === true;
  const maxCount = args.max_count !== undefined ? Math.max(1, Number(args.max_count)) : 200;
  if (!pattern) return "error: pattern required";

  if (hasRg()) {
    const rgArgs = ["--files", "--color=never"];
    if (includeHidden) rgArgs.push("--hidden");
    rgArgs.push(caseInsensitive ? "--iglob" : "-g", pattern);
    const r = await runCmd("rg", rgArgs, ctx.cwd);
    // rg --files exit: 0=matches found or empty tree, 1=no matches (some versions), 2=error
    if (r.exitCode === 2) return `error: ${r.stderr.trim() || "rg failed"}`;
    const files = r.stdout.split("\n").filter((l) => l.length > 0);
    if (files.length === 0) return `no files match: ${pattern}`;
    const shown = files.slice(0, maxCount).join("\n");
    const tail = files.length > maxCount ? `\n[… ${files.length - maxCount} more files]` : "";
    return truncate(`files: ${files.length}\n${shown}${tail}`);
  }

  // Fallback: find — support globstar via -path when pattern contains /
  const isPath = pattern.includes("/");
  const pruneDirs = ["node_modules", ".git", "dist", "build", ".next", "target", "vendor"];
  const pruneExpr = pruneDirs.map((d) => `-path '*/${d}/*' -prune`).join(" -o ");
  const matchFlag = caseInsensitive ? (isPath ? "-ipath" : "-iname") : (isPath ? "-path" : "-name");
  // Translate ** to the equivalent: -path "./app/**/kernel.php" → find treats ** as two stars, so replace with just *
  // find -path does not natively understand **; use bash globstar via shopt -s globstar
  if (isPath && pattern.includes("**")) {
    const cmd = `shopt -s globstar nullglob; for f in ${pattern}; do [ -f "$f" ] && echo "$f"; done | head -n ${maxCount}`;
    const out = await bash({ command: cmd, timeout: 30000 }, ctx);
    const m = out.match(/stdout:\n([\s\S]*)/);
    const files = (m?.[1] ?? "").split("\n").filter((l) => l.length > 0);
    if (files.length === 0) return `no files match: ${pattern}`;
    return `files: ${files.length}\n${files.join("\n")}`;
  }
  const cmd = `find . -type f ${pruneExpr ? `\\( ${pruneExpr} \\) -o -type f` : ""} ${matchFlag} ${JSON.stringify(pattern)} -print | head -n ${maxCount}`;
  const out = await bash({ command: cmd, timeout: 30000 }, ctx);
  const m = out.match(/stdout:\n([\s\S]*)/);
  const files = (m?.[1] ?? "").split("\n").filter((l) => l.length > 0);
  if (files.length === 0) return `no files match: ${pattern}`;
  return `files: ${files.length}\n${files.join("\n")}`;
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

  // Auto-fallback: multi_edit on an empty or missing file with empty
  // old_strings is really a write. Concatenate new_strings in order.
  let existing = "";
  let fileExists = false;
  try { existing = await fs.readFile(abs, "utf8"); fileExists = true; } catch { /* missing */ }
  const allEmptyOld = edits.every((e) => {
    const o = (e as { old_string?: unknown }).old_string;
    return !o || String(o).length === 0;
  });
  if ((!fileExists || existing.length === 0) && allEmptyOld) {
    const combined = edits
      .map((e) => String((e as { new_string?: unknown }).new_string ?? ""))
      .join("");
    if (combined) {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, combined, "utf8");
      ctx.readPaths?.add(abs);
      return `ok: wrote ${combined.length} bytes to ${abs} (multi_edit on empty file — next time use write_file for new content)`;
    }
  }

  const guard = requireReadFirst(ctx, abs);
  if (guard) return guard;
  try {
    let content = existing;
    let applied = 0;
    for (let i = 0; i < edits.length; i++) {
      const e = edits[i] as { old_string?: unknown; new_string?: unknown };
      const oldStr = String(e?.old_string ?? "");
      const newStr = String(e?.new_string ?? "");
      if (!oldStr) return `error: edit #${i + 1} missing old_string — use write_file to create/fill a file, or read_file first then supply the exact text to replace`;
      const idx = content.indexOf(oldStr);
      if (idx === -1) return `error: edit #${i + 1} old_string not found — read_file the path first to see current content`;
      const count = content.split(oldStr).length - 1;
      if (count > 1) return `error: edit #${i + 1} old_string matches ${count} times; add more surrounding context to make it unique`;
      content = content.replace(oldStr, newStr);
      applied++;
    }
    await fs.writeFile(abs, content, "utf8");
    return `ok: applied ${applied} edit(s) to ${abs}`;
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function todoWrite(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const raw = args.todos;
  if (!Array.isArray(raw)) return "error: todos array required";
  const list: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i] as { id?: unknown; content?: unknown; status?: unknown };
    const id = String(it?.id ?? i + 1);
    const content = String(it?.content ?? "").trim();
    const statusRaw = String(it?.status ?? "pending").trim();
    if (!content) return `error: todo #${i + 1} missing content`;
    const status = (["pending", "in_progress", "done"] as const).includes(statusRaw as "pending")
      ? (statusRaw as TodoItem["status"])
      : "pending";
    list.push({ id, content, status });
  }
  if (ctx.todos) {
    ctx.todos.length = 0;
    ctx.todos.push(...list);
  }
  const rendered = list
    .map((t) => {
      const mark = t.status === "done" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
      return `  ${mark} ${t.content}`;
    })
    .join("\n");
  return `ok: ${list.length} todo(s)\n${rendered}`;
}

const READ_ALL_SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".next", "out", "target",
  "vendor", ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  ".turbo", ".cache", ".parcel-cache", ".agentic", ".vscode", ".idea",
  "coverage", ".nyc_output",
]);
const READ_ALL_SKIP_FILES = new Set([
  ".DS_Store", "Thumbs.db", "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb",
]);
const READ_ALL_TEXT_EXT = /\.(m?[jt]sx?|py|rb|go|rs|java|kt|swift|php|cs|c|cc|cpp|h|hpp|sh|zsh|bash|fish|lua|pl|pm|scala|clj|ex|exs|erl|hs|ml|dart|sql|r|jl|sol|md|mdx|txt|json|yaml|yml|toml|ini|conf|cfg|env|html?|css|scss|sass|less|xml|svg|gitignore|editorconfig|prettierrc|eslintrc|babelrc|dockerignore|dockerfile|makefile|rakefile|gemfile|procfile)$/i;

async function isProbablyText(abs: string, stat: import("node:fs").Stats): Promise<boolean> {
  if (stat.size === 0) return true;
  if (stat.size > 5 * 1024 * 1024) return false;
  const base = path.basename(abs);
  if (READ_ALL_TEXT_EXT.test(base)) return true;
  if (/^(Dockerfile|Makefile|Rakefile|Gemfile|Procfile|\..+rc|\.env.*)$/i.test(base)) return true;
  // Sniff first 512 bytes for NUL bytes.
  try {
    const fd = await fs.open(abs, "r");
    try {
      const buf = Buffer.alloc(Math.min(512, Number(stat.size)));
      await fd.read(buf, 0, buf.length, 0);
      return !buf.includes(0);
    } finally {
      await fd.close();
    }
  } catch {
    return false;
  }
}

async function readAll(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const root = resolveInside(ctx.cwd, String(args.path ?? "."));
  const maxFiles = args.max_files !== undefined ? Math.max(1, Number(args.max_files)) : 50;
  const maxBytesPerFile = args.max_bytes_per_file !== undefined ? Math.max(100, Number(args.max_bytes_per_file)) : 20000;
  const includeHidden = args.hidden === true;

  try {
    const stat = await fs.stat(root);
    if (!stat.isDirectory()) {
      // Single-file convenience: just read it.
      return readFile({ path: root }, ctx);
    }
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }

  const paths: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      if (!includeHidden && e.name.startsWith(".")) continue;
      if (e.isDirectory()) {
        if (READ_ALL_SKIP_DIRS.has(e.name)) continue;
        await walk(path.join(dir, e.name));
      } else if (e.isFile()) {
        if (READ_ALL_SKIP_FILES.has(e.name)) continue;
        paths.push(path.join(dir, e.name));
        if (paths.length >= maxFiles * 4) return; // oversample, filter later
      }
    }
  }
  await walk(root);

  if (paths.length === 0) return `read_all: no files found under ${root}`;

  const outParts: string[] = [];
  let included = 0, skippedBinary = 0;
  for (const p of paths) {
    if (included >= maxFiles) break;
    let stat;
    try { stat = await fs.stat(p); } catch { continue; }
    if (!(await isProbablyText(p, stat))) { skippedBinary++; continue; }
    let content: string;
    try {
      const buf = await fs.readFile(p);
      if (buf.length > maxBytesPerFile) {
        content = buf.slice(0, maxBytesPerFile).toString("utf8") + `\n[… truncated, ${buf.length - maxBytesPerFile} more bytes]`;
      } else {
        content = buf.toString("utf8");
      }
    } catch (e) {
      content = `[read error: ${(e as Error).message}]`;
    }
    const rel = path.relative(ctx.cwd, p) || p;
    ctx.readPaths?.add(p);
    outParts.push(`=== ${rel}  (${stat.size} bytes) ===\n${content}`);
    included++;
  }
  const header = `read_all: ${included} file(s) from ${path.relative(ctx.cwd, root) || root}` +
    (skippedBinary ? ` (skipped ${skippedBinary} binary)` : "") +
    (paths.length > included ? ` [${paths.length - included} more not shown; raise max_files]` : "");
  return truncate(`${header}\n\n${outParts.join("\n\n")}`);
}

async function bgList(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const procs = ctx.bgProcs ?? [];
  if (procs.length === 0) return "no background processes";
  const lines = procs.map((p) => {
    const age = ((Date.now() - p.startedAt) / 1000).toFixed(1);
    const state = p.status === "running" ? `running` : `exited(${p.exitCode ?? "?"})`;
    const cmd = p.command.length > 100 ? p.command.slice(0, 97) + "..." : p.command;
    return `id=${p.id} pid=${p.pid} ${state} age=${age}s  $ ${cmd}`;
  });
  return lines.join("\n");
}

async function bgLogs(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const id = Number(args.id);
  if (!Number.isFinite(id)) return "error: id required";
  const proc = (ctx.bgProcs ?? []).find((p) => p.id === id);
  if (!proc) return `error: no bg process id=${id}`;
  const tail = args.tail !== undefined ? Math.max(1, Number(args.tail)) : 200;
  try {
    const raw = await fs.readFile(proc.logPath, "utf8");
    const lines = raw.split("\n");
    const slice = lines.slice(-tail).join("\n");
    const state = proc.status === "running" ? "running" : `exited(${proc.exitCode ?? "?"})`;
    return truncate(`bg id=${id} pid=${proc.pid} ${state}\n$ ${proc.command}\n---\n${slice}`);
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

async function bgStop(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const id = Number(args.id);
  if (!Number.isFinite(id)) return "error: id required";
  const proc = (ctx.bgProcs ?? []).find((p) => p.id === id);
  if (!proc) return `error: no bg process id=${id}`;
  if (proc.status !== "running") return `bg id=${id} already exited(${proc.exitCode ?? "?"})`;
  const signal = args.signal === "KILL" || args.force === true ? "SIGKILL" : "SIGTERM";
  try {
    try { process.kill(-proc.pid, signal); } catch { process.kill(proc.pid, signal); }
    proc.status = "exited";
    if (proc.exitCode === null) proc.exitCode = -1;
    return `ok: sent ${signal} to bg id=${id} pid=${proc.pid}`;
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
      "Run a shell command in the current working directory. Use for git, npm, grep, curl, system inspection, package managers, scaffolding (e.g. 'npm create vite@latest myapp -- --template react'), builds, tests, etc. Returns exit_code, stdout, stderr. For long-running tasks like dev servers pass background=true — the command runs detached and stdout+stderr go to a log file; use bg_logs/bg_stop to inspect/kill it. Bump timeout for slow installs/builds (e.g. 600000).",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout: { type: "number", description: "Timeout in ms (default 120000)" },
        background: { type: "boolean", description: "Run detached; return immediately with bg id/pid/logPath. Use for servers or watchers." },
      },
      required: ["command"],
    },
    dangerous: true,
  },
  {
    name: "read_all",
    description:
      "Read every text file under a directory (recursive) in one call and return their contents concatenated with headers. Use this for 'read all files', 'show me the code', 'what's in this repo' — do NOT orchestrate list_dir + read_file manually. Skips node_modules/.git/dist/build/.next/vendor/etc. and binary files by default. Returns up to max_files (default 50) files truncated to max_bytes_per_file (default 20000) each. Safe, side-effect-free.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory or file (default cwd)." },
        max_files: { type: "number", description: "Max files to include (default 50)." },
        max_bytes_per_file: { type: "number", description: "Per-file byte cap (default 20000)." },
        hidden: { type: "boolean", description: "Include dotfiles/dotdirs (default false)." },
      },
    },
    dangerous: false,
  },
  {
    name: "bg_list",
    description: "List background processes started via bash(background=true) with their status.",
    parameters: { type: "object", properties: {} },
    dangerous: false,
  },
  {
    name: "bg_logs",
    description: "Read the tail of a background process's combined stdout+stderr log.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number", description: "Background process id (from bash background=true result or bg_list)" },
        tail: { type: "number", description: "Max lines from end of log (default 200)" },
      },
      required: ["id"],
    },
    dangerous: false,
  },
  {
    name: "bg_stop",
    description: "Stop a background process. Sends SIGTERM by default; pass force=true for SIGKILL.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "number" },
        force: { type: "boolean", description: "Use SIGKILL instead of SIGTERM" },
      },
      required: ["id"],
    },
    dangerous: true,
  },
  {
    name: "read_file",
    description:
      "Read contents of a file, returned with 1-based line numbers (cat -n style). Path relative to cwd or absolute. Supports offset (0-based line index) and limit for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: { type: "number", description: "Start line (0-based). Default 0." },
        limit: { type: "number", description: "Max lines to return." },
      },
      required: ["path"],
    },
    dangerous: false,
  },
  {
    name: "write_file",
    description: "Create a new file OR overwrite an existing file with the given content. Use this to fill an empty file or write a brand-new one. Creates parent dirs. If the file already has content you want to preserve, use edit_file instead.",
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
      "Replace exactly one occurrence of old_string with new_string in an EXISTING non-empty file. Fails if old_string is missing or not unique. Do NOT use on empty/new files — use write_file for that.",
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
    description:
      "Recursive regex search (ripgrep when available). Output is 'file:line:match'. Respects .gitignore. Smart-case by default. Supports language filter ('ts','py','rust','go','php','js'), glob include filter ('src/**/*.ts'), and context lines. Returns 'no matches for: <pattern>' when empty.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regex pattern (PCRE-ish via ripgrep)." },
        path: { type: "string", description: "Directory to search (default .)" },
        type: { type: "string", description: "Language filter, e.g. ts, py, rust, go, php." },
        glob: { type: "string", description: "Glob to include, e.g. 'app/**/*.php'." },
        ignore_case: { type: "boolean", description: "Force case-insensitive (otherwise smart case)." },
        context: { type: "number", description: "Lines of context before+after each match." },
        max_count: { type: "number", description: "Max matches to return (default 200)." },
      },
      required: ["pattern"],
    },
    dangerous: false,
  },
  {
    name: "glob",
    description:
      "Find files by glob pattern. Uses ripgrep when available so '**' globstar works correctly ('app/**/Kernel.php' matches any depth). Case-sensitive by default; set ignore_case for case-insensitive (e.g. kernel.php would match Kernel.php). Respects .gitignore. Returns 'no files match: <pattern>' when empty. Use a full path glob when you know structure; use '**/<basename>' when you only know the filename.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts' or '**/Kernel.php'." },
        ignore_case: { type: "boolean", description: "Case-insensitive match." },
        hidden: { type: "boolean", description: "Include hidden files (default false)." },
        max_count: { type: "number", description: "Max files to return (default 200)." },
      },
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
  {
    name: "todo_write",
    description:
      "Replace the session's plan with a new list of todos. Use to break a task into steps and track progress. Each todo has id, content, and status (pending|in_progress|done). Re-call to update status as work progresses.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "done"] },
            },
            required: ["content"],
          },
        },
      },
      required: ["todos"],
    },
    dangerous: false,
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
  todo_write: todoWrite,
  read_all: readAll,
  bg_list: bgList,
  bg_logs: bgLogs,
  bg_stop: bgStop,
};

export function findTool(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}
