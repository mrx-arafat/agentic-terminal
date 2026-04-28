/** Per-tool presentation: how a tool call's args + result render in a card. */
export interface ToolPresentation {
  /** Short text after the tool name on the header line. May be "". */
  summary: string;
  /** Body lines (no gutter prefix — renderer adds it). Empty = header-only card. */
  bodyLines: string[];
  /** Compact chips that appear before status (e.g. "+12 -3", "exit 0", "47 lines"). */
  chips: string[];
}

const SUMMARY_MAX = 70;
const COMMAND_MAX = 60;
const FALLBACK_SUMMARY_MAX = 80;

function truncateMid(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function trimEnd(s: string): string {
  return s.replace(/[ \t\r]+$/u, "");
}

function splitLines(s: string): string[] {
  return s.split("\n").map(trimEnd);
}

function isErrorLine(line: string): boolean {
  return /^error:/i.test(line);
}

function getString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (typeof v === "string" && v.length > 0) return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function pickFirst(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = getString(args, k);
    if (v !== undefined) return v;
  }
  return undefined;
}

function takeNonEmpty(lines: string[], limit: number): string[] {
  const out: string[] = [];
  let prevBlank = false;
  for (const raw of lines) {
    const l = raw;
    const blank = l.trim().length === 0;
    if (blank && (prevBlank || out.length === 0)) {
      prevBlank = true;
      continue;
    }
    out.push(l);
    prevBlank = blank;
    if (out.length >= limit) break;
  }
  while (out.length > 0 && out[out.length - 1].trim().length === 0) out.pop();
  return out;
}

function withMore(shown: string[], totalAvailable: number): string[] {
  const more = totalAvailable - shown.length;
  if (more > 0) return [...shown, `… ${more} more`];
  return shown;
}

function errorBody(result: string): string[] {
  const lines = splitLines(result).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const first = lines[0];
  if (isErrorLine(first)) return takeNonEmpty(lines, 8);
  return takeNonEmpty(lines, 8);
}

function presentTodoWrite(
  result: string | null,
  ok: boolean,
): ToolPresentation {
  if (result === null) {
    return { summary: "updating tasks…", bodyLines: [], chips: [] };
  }
  if (!ok) {
    return { summary: "failed", bodyLines: errorBody(result), chips: [] };
  }
  const lines = splitLines(result);
  const items: { status: "done" | "active" | "pending"; content: string }[] = [];
  for (const raw of lines) {
    const m = raw.match(/^\s{2}\[(x|~| )\]\s+(.*)$/);
    if (!m) continue;
    const mark = m[1];
    const content = m[2];
    if (mark === "x") items.push({ status: "done", content });
    else if (mark === "~") items.push({ status: "active", content });
    else items.push({ status: "pending", content });
  }
  const total = items.length;
  const done = items.filter((i) => i.status === "done").length;
  const active = items.filter((i) => i.status === "active").length;
  const summary = `${total} task${total === 1 ? "" : "s"} · ${done} done · ${active} active`;
  const body = items.map((i) => {
    const glyph = i.status === "done" ? "✓" : i.status === "active" ? "→" : "○";
    return `${glyph} ${i.content}`;
  });
  return { summary: truncateMid(summary, SUMMARY_MAX), bodyLines: body, chips: [] };
}

function presentRead(
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const path = getString(args, "path") ?? "";
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  let summary = path;
  if (offset !== undefined || limit !== undefined) {
    const start = offset !== undefined ? offset : 0;
    const end = limit !== undefined ? start + limit : undefined;
    summary = `${path}${end !== undefined ? `:${start}-${end}` : `:${start}+`}`;
  }
  summary = truncateMid(summary, SUMMARY_MAX);

  if (result === null) return { summary, bodyLines: [], chips: [] };
  if (!ok) return { summary, bodyLines: errorBody(result), chips: [] };

  const allLines = splitLines(result);
  const moreMatch = result.match(/\[…\s*(\d+)\s*more\s*lines/);
  const numberedCount = allLines.filter((l) => /^\s*\d+\t/.test(l)).length;
  const totalLines = numberedCount + (moreMatch ? Number(moreMatch[1]) : 0);
  const chips = totalLines > 0 ? [`${totalLines} line${totalLines === 1 ? "" : "s"}`] : [];

  if (allLines.length <= 4) {
    return { summary, bodyLines: [], chips };
  }
  const shown = takeNonEmpty(allLines, 4);
  const remaining = allLines.length - shown.length;
  const body = remaining > 0 ? [...shown, `… ${remaining} more`] : shown;
  return { summary, bodyLines: body, chips };
}

function presentReadAll(
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const path = getString(args, "path") ?? ".";
  const summary = truncateMid(path, SUMMARY_MAX);
  if (result === null) return { summary, bodyLines: [], chips: [] };
  if (!ok) return { summary, bodyLines: errorBody(result), chips: [] };

  const lines = splitLines(result);
  const headerMatch = result.match(/read_all:\s+(\d+)\s+file\(s\)/);
  const fileCount = headerMatch ? Number(headerMatch[1]) : 0;
  const chips = fileCount > 0 ? [`${fileCount} file${fileCount === 1 ? "" : "s"}`] : [];

  if (lines.length <= 4) return { summary, bodyLines: [], chips };
  const shown = takeNonEmpty(lines, 4);
  const remaining = lines.length - shown.length;
  const body = remaining > 0 ? [...shown, `… ${remaining} more`] : shown;
  return { summary, bodyLines: body, chips };
}

function presentWriteFile(
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const path = getString(args, "path") ?? "";
  const summary = truncateMid(path, SUMMARY_MAX);
  const content = typeof args.content === "string" ? args.content : "";
  const linesAdded = content.length > 0 ? content.split("\n").length : 0;
  const chips = linesAdded > 0 ? [`+${linesAdded}`] : [];

  if (result === null) return { summary, bodyLines: [], chips };
  if (!ok) return { summary, bodyLines: errorBody(result), chips };

  // Header-only on success unless message is something other than the standard "ok: wrote ..."
  const first = splitLines(result)[0] ?? "";
  if (/^ok:\s+wrote\s+\d+\s+bytes/i.test(first)) {
    return { summary, bodyLines: [], chips };
  }
  return { summary, bodyLines: takeNonEmpty(splitLines(result), 4), chips };
}

function parseDiffStat(result: string): { added: number; removed: number; hasDiff: boolean } {
  let added = 0;
  let removed = 0;
  let hasDiff = false;
  for (const raw of result.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---")) { hasDiff = true; continue; }
    if (raw.startsWith("@@")) { hasDiff = true; continue; }
    if (raw.startsWith("+")) { added++; hasDiff = true; }
    else if (raw.startsWith("-")) { removed++; hasDiff = true; }
  }
  return { added, removed, hasDiff };
}

function presentEditFile(
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const path = getString(args, "path") ?? "";
  const summary = truncateMid(path, SUMMARY_MAX);

  // Try to estimate +/- from old_string / new_string when no diff in result.
  const oldStr = typeof args.old_string === "string" ? args.old_string : "";
  const newStr = typeof args.new_string === "string" ? args.new_string : "";
  let added = 0;
  let removed = 0;
  if (oldStr || newStr) {
    const oldLines = oldStr ? oldStr.split("\n").length : 0;
    const newLines = newStr ? newStr.split("\n").length : 0;
    if (newLines > oldLines) added = newLines - oldLines;
    else if (oldLines > newLines) removed = oldLines - newLines;
    if (oldStr && newStr && oldLines === newLines) {
      added = newLines;
      removed = oldLines;
    }
  }

  if (result === null) {
    const chips: string[] = [];
    if (added || removed) chips.push(`+${added} -${removed}`);
    return { summary, bodyLines: [], chips };
  }
  if (!ok) return { summary, bodyLines: errorBody(result), chips: [] };

  const stat = parseDiffStat(result);
  const chips: string[] = [];
  if (stat.hasDiff) chips.push(`+${stat.added} -${stat.removed}`);
  else if (added || removed) chips.push(`+${added} -${removed}`);

  if (stat.hasDiff) {
    const allLines = splitLines(result);
    const hunkIdx = allLines.findIndex((l) => l.startsWith("@@"));
    const start = hunkIdx >= 0 ? hunkIdx : 0;
    const slice = allLines.slice(start);
    const shown = slice.slice(0, 12);
    const remaining = slice.length - shown.length;
    const body = remaining > 0 ? [...shown, `… ${remaining} more`] : shown;
    return { summary, bodyLines: body, chips };
  }

  // Standard edit_file/multi_edit: `ok: replaced 1 occurrence in <abs>` — header-only.
  return { summary, bodyLines: [], chips };
}

function parseExitCode(result: string): number | null {
  const m = result.match(/exit_code:\s*(-?\d+|\?)/);
  if (!m) {
    const m2 = result.match(/^exit\s+code:\s*(-?\d+)/im);
    if (!m2) return null;
    const n = Number(m2[1]);
    return Number.isFinite(n) ? n : null;
  }
  if (m[1] === "?") return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function extractStdoutStderr(result: string): { stdout: string; stderr: string } {
  // Format: `exit_code: N\nstdout:\n<...>\nstderr:\n<...>` — sections may be absent.
  let stdout = "";
  let stderr = "";
  const stdoutMatch = result.match(/stdout:\n([\s\S]*?)(?=\nstderr:\n|$)/);
  if (stdoutMatch) stdout = stdoutMatch[1];
  const stderrMatch = result.match(/stderr:\n([\s\S]*)$/);
  if (stderrMatch) stderr = stderrMatch[1];
  return { stdout, stderr };
}

function presentBash(
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const command = getString(args, "command") ?? "";
  const summary = truncateMid(command, COMMAND_MAX);

  if (result === null) return { summary, bodyLines: [], chips: [] };

  // Background-start surface: `ok: started bg id=N pid=P logPath=...`
  if (/^ok:\s+started\s+bg/i.test(result)) {
    const pidMatch = result.match(/pid=(-?\d+)/);
    const chips = pidMatch ? [`pid ${pidMatch[1]}`] : [];
    const lines = takeNonEmpty(splitLines(result), 6);
    return { summary, bodyLines: lines, chips };
  }

  if (!ok) {
    // Surface stderr (up to 16 lines) on failure; include exit code chip if present.
    const exit = parseExitCode(result);
    const chips: string[] = [];
    if (exit !== null) chips.push(`exit ${exit}`);
    else chips.push("done");
    const { stdout, stderr } = extractStdoutStderr(result);
    let lines: string[];
    if (stderr.trim().length > 0) {
      lines = splitLines(stderr).filter((l) => l.trim().length > 0).slice(0, 16);
    } else if (stdout.trim().length > 0) {
      lines = splitLines(stdout).filter((l) => l.trim().length > 0).slice(0, 8);
    } else {
      lines = errorBody(result);
    }
    return { summary, bodyLines: lines, chips };
  }

  const exit = parseExitCode(result);
  const chips: string[] = [];
  if (exit !== null) chips.push(`exit ${exit}`);
  else chips.push("done");
  const { stdout, stderr } = extractStdoutStderr(result);
  const combined = (stdout + (stderr ? `\n${stderr}` : "")).trim();
  if (combined.length === 0) return { summary, bodyLines: [], chips };
  const nonBlank = splitLines(combined).filter((l) => l.trim().length > 0);
  const lines = nonBlank.slice(0, 8);
  return { summary, bodyLines: lines, chips };
}

function presentGrep(
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const pattern = getString(args, "pattern") ?? "";
  const summary = truncateMid(pattern, SUMMARY_MAX);

  if (result === null) return { summary, bodyLines: [], chips: [] };
  if (!ok) return { summary, bodyLines: errorBody(result), chips: [] };

  // `no matches for: <pattern>` → header-only with 0 matches chip
  if (/^no matches for:/i.test(result.trim())) {
    return { summary, bodyLines: [], chips: ["0 matches"] };
  }

  // ripgrep path: `matches: N in M file(s)\n<hits>`
  const headerMatch = result.match(/^matches:\s+(\d+)\s+in\s+(\d+)\s+file\(s\)/i);
  const hitLines = splitLines(result).filter((l) => /^[^\s].*?:\d+:/.test(l));

  let chips: string[] = [];
  if (headerMatch) {
    const n = Number(headerMatch[1]);
    const m = Number(headerMatch[2]);
    chips = [`${n} match${n === 1 ? "" : "es"} in ${m} file${m === 1 ? "" : "s"}`];
  } else if (hitLines.length > 0) {
    const fileSet = new Set(hitLines.map((l) => l.split(":")[0]));
    chips = [`${hitLines.length} match${hitLines.length === 1 ? "" : "es"} in ${fileSet.size} file${fileSet.size === 1 ? "" : "s"}`];
  }

  const shown = hitLines.slice(0, 6);
  const body = hitLines.length > shown.length ? [...shown, `… ${hitLines.length - shown.length} more`] : shown;
  return { summary, bodyLines: body, chips };
}

function presentGlob(
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const pattern = getString(args, "pattern") ?? "";
  const summary = truncateMid(pattern, SUMMARY_MAX);

  if (result === null) return { summary, bodyLines: [], chips: [] };
  if (!ok) return { summary, bodyLines: errorBody(result), chips: [] };

  if (/^no files match:/i.test(result.trim())) {
    return { summary, bodyLines: [], chips: ["0 items"] };
  }

  const lines = splitLines(result);
  const headerMatch = result.match(/^files:\s+(\d+)/);
  const entries = headerMatch ? lines.slice(1).filter((l) => l.length > 0 && !l.startsWith("[…")) : lines.filter((l) => l.length > 0);
  const total = headerMatch ? Number(headerMatch[1]) : entries.length;
  const chips = [`${total} item${total === 1 ? "" : "s"}`];
  const shown = entries.slice(0, 8);
  const body = entries.length > shown.length ? [...shown, `… ${entries.length - shown.length} more`] : shown;
  return { summary, bodyLines: body, chips };
}

function presentListDir(
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const path = getString(args, "path") ?? ".";
  const summary = truncateMid(path, SUMMARY_MAX);

  if (result === null) return { summary, bodyLines: [], chips: [] };
  if (!ok) return { summary, bodyLines: errorBody(result), chips: [] };

  if (result.trim() === "(empty)") return { summary, bodyLines: [], chips: ["0 items"] };

  const entries = splitLines(result).filter((l) => l.length > 0);
  const chips = [`${entries.length} item${entries.length === 1 ? "" : "s"}`];
  const shown = entries.slice(0, 8);
  const body = entries.length > shown.length ? [...shown, `… ${entries.length - shown.length} more`] : shown;
  return { summary, bodyLines: body, chips };
}

function presentBg(
  name: string,
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const id = getString(args, "id");
  const command = getString(args, "command");
  const summary = truncateMid(command ?? (id !== undefined ? `id=${id}` : name), SUMMARY_MAX);

  if (result === null) return { summary, bodyLines: [], chips: [] };
  if (!ok) return { summary, bodyLines: errorBody(result), chips: [] };

  const pidMatch = result.match(/pid[=\s]+(-?\d+)/);
  const chips = pidMatch ? [`pid ${pidMatch[1]}`] : [];
  const lines = takeNonEmpty(splitLines(result), 6);
  return { summary, bodyLines: lines, chips };
}

function isMcpName(name: string): boolean {
  return name.includes(":") || name.startsWith("mcp_") || name.startsWith("mcp__");
}

function presentMcp(
  name: string,
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const preferred = pickFirst(args, ["query", "name", "id", "path"]);
  let chosen = preferred;
  if (chosen === undefined) {
    const keys = Object.keys(args);
    if (keys.length > 0) {
      const k = keys[0];
      const v = args[k];
      chosen = typeof v === "string" || typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : JSON.stringify(v);
    }
  }
  const summary = truncateMid(chosen ?? name, SUMMARY_MAX);

  if (result === null) return { summary, bodyLines: [], chips: [] };
  if (!ok) return { summary, bodyLines: errorBody(result), chips: [] };

  const lines = takeNonEmpty(splitLines(result), 4);
  const remaining = splitLines(result).length - lines.length;
  const body = lines.length > 0 && remaining > 0 ? [...lines, `… ${remaining} more`] : lines;
  return { summary, bodyLines: body, chips: [] };
}

function presentGeneric(
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const preferred = pickFirst(args, ["command", "path", "pattern", "query", "name"]);
  let summary: string;
  if (preferred !== undefined) {
    summary = truncateMid(preferred, SUMMARY_MAX);
  } else if (Object.keys(args).length === 0) {
    summary = "";
  } else {
    summary = truncateMid(JSON.stringify(args), FALLBACK_SUMMARY_MAX);
  }

  if (result === null) return { summary, bodyLines: [], chips: [] };
  if (!ok) return { summary, bodyLines: errorBody(result), chips: [] };

  const all = splitLines(result).filter((l, i, arr) => !(l.length === 0 && (i === 0 || i === arr.length - 1)));
  if (all.length === 0) return { summary, bodyLines: [], chips: [] };
  const shown = takeNonEmpty(all, 4);
  const remaining = all.length - shown.length;
  const body = remaining > 0 ? [...shown, `… ${remaining} more`] : shown;
  return { summary, bodyLines: body, chips: [] };
}

/**
 * Build a presentation for a tool call.
 *
 * @param name    Tool name (e.g. "read_file", "bash", or an MCP-prefixed name).
 * @param args    Raw tool arguments object.
 * @param result  Tool result text (null when the call is still running).
 * @param ok      true if the result represents success; false on failure.
 */
export function presentTool(
  name: string,
  args: Record<string, unknown>,
  result: string | null,
  ok: boolean,
): ToolPresentation {
  const safeArgs = args ?? {};

  switch (name) {
    case "todo_write":
      return presentTodoWrite(result, ok);
    case "read_file":
    case "read":
      return presentRead(safeArgs, result, ok);
    case "read_all":
      return presentReadAll(safeArgs, result, ok);
    case "write_file":
      return presentWriteFile(safeArgs, result, ok);
    case "edit_file":
    case "apply_patch":
    case "multi_edit":
      return presentEditFile(safeArgs, result, ok);
    case "bash":
    case "run_command":
    case "shell":
      return presentBash(safeArgs, result, ok);
    case "grep":
      return presentGrep(safeArgs, result, ok);
    case "glob":
      return presentGlob(safeArgs, result, ok);
    case "list_dir":
      return presentListDir(safeArgs, result, ok);
  }

  if (name.startsWith("bg_")) return presentBg(name, safeArgs, result, ok);
  if (isMcpName(name)) return presentMcp(name, safeArgs, result, ok);

  return presentGeneric(safeArgs, result, ok);
}
