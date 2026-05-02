import chalk from "chalk";
import { presentTool, type ToolPresentation } from "./tool-formatters.js";

export type CardState = "done" | "failed";

export interface RenderCardInput {
  name: string;
  args: Record<string, unknown>;
  state: CardState;
  result: string;
  durationMs: number;
  /** Optional override (mainly for tests) — defaults to presentTool(name, args, result, ok). */
  presentation?: ToolPresentation;
}

const formatDuration = (ms: number): string => {
  const seconds = ms / 1000;
  return `${seconds.toFixed(1)}s`;
};

const colorChip = (chip: string): string => {
  // Diff add chip (e.g. "+12") → green, del chip ("-3") → red, "exit N" non-zero → red.
  if (/^\+\d+$/.test(chip)) return chalk.green(chip);
  if (/^-\d+$/.test(chip)) return chalk.red(chip);
  const exitMatch = /^exit\s+(-?\d+)$/i.exec(chip);
  if (exitMatch && exitMatch[1] !== "0") return chalk.red(chip);
  return chalk.gray(chip);
};

const renderChips = (chips: string[]): string => {
  if (chips.length === 0) return "";
  const sep = ` ${chalk.dim("·")} `;
  return chips.map(colorChip).join(sep);
};

// Truecolor backgrounds — subtle, like Warp/VSCode diff view.
const BG_ADD = chalk.bgRgb(20, 60, 30);
const BG_DEL = chalk.bgRgb(70, 25, 30);
const FG_ADD = chalk.rgb(120, 230, 140);
const FG_DEL = chalk.rgb(255, 140, 150);
const FG_NUM = chalk.rgb(110, 110, 130);

/**
 * Numbered-diff lines emitted by buildNumberedDiff() are:
 *   "<num> +<text>" | "<num> -<text>" | "<num>  <text>"
 * Apply line-number gutter dim, bg color, and sign color across the row.
 */
const colorDiffLine = (line: string): string => {
  if (line.startsWith("@@")) return chalk.cyan(line);
  if (line.startsWith("+++") || line.startsWith("---")) return line;
  if (line.startsWith("… ") || line === "…" || /^…\s/.test(line)) return chalk.dim(line);
  // Numbered form: "  142 +foo"
  const m = line.match(/^(\s*)(\d+)\s([-+ ])(.*)$/);
  if (m) {
    const [, lead, num, sign, content] = m;
    const numStr = `${lead}${FG_NUM(num)} `;
    if (sign === "+") return numStr + BG_ADD(FG_ADD(`+${content}`));
    if (sign === "-") return numStr + BG_DEL(FG_DEL(`-${content}`));
    return numStr + chalk.dim(` ${content}`);
  }
  // Blank-context form (trailing space already stripped): "  142"
  const blank = line.match(/^(\s*)(\d+)\s*$/);
  if (blank) {
    const [, lead, num] = blank;
    return `${lead}${FG_NUM(num)}`;
  }
  // Plain unified-diff fallback
  if (line.startsWith("+")) return BG_ADD(FG_ADD(line));
  if (line.startsWith("-")) return BG_DEL(FG_DEL(line));
  return line;
};

/** Map raw tool names to short verb form (Claude-Code style). */
const DISPLAY_NAME: Record<string, string> = {
  read_file: "Read",
  read: "Read",
  read_all: "ReadAll",
  write_file: "Write",
  edit_file: "Update",
  multi_edit: "Update",
  apply_patch: "Update",
  bash: "Bash",
  run_command: "Bash",
  shell: "Bash",
  grep: "Search",
  glob: "Glob",
  list_dir: "List",
  todo_write: "TodoWrite",
};

const displayName = (name: string): string => {
  if (DISPLAY_NAME[name]) return DISPLAY_NAME[name];
  if (name.startsWith("bg_")) {
    const rest = name.slice(3);
    return "Bg" + rest.charAt(0).toUpperCase() + rest.slice(1);
  }
  return name;
};

/** Build header: `● Verb(arg)  +chip -chip   <dim duration on slow>` */
const buildHeaderLine = (
  glyph: string,
  rawName: string,
  summary: string,
  chips: string[],
  durationMs: number,
  showRunning: boolean,
): string => {
  const verb = chalk.bold(displayName(rawName));
  const argInParen = summary.length > 0 ? chalk.gray(`(${summary})`) : "";
  const parts: string[] = [glyph, " ", verb, argInParen];
  if (chips.length > 0) parts.push("  ", renderChips(chips));

  // Duration: only show when running (live spinner) OR slow (>2s).
  if (showRunning) {
    parts.push("  ", chalk.dim(formatDuration(durationMs)));
  } else if (durationMs >= 2000) {
    const durStr = formatDuration(durationMs);
    const dur = durationMs > 10_000 ? chalk.bold.dim(durStr) : chalk.dim(durStr);
    parts.push("  ", dur);
  }
  return parts.join("");
};

/** Render a complete tool card (header + body) to a string. No trailing newline. */
export function renderToolCard(input: RenderCardInput): string {
  const ok = input.state === "done";
  const presentation =
    input.presentation ?? presentTool(input.name, input.args, input.result, ok);

  const glyph = ok ? chalk.green("●") : chalk.red("✕");

  const header = buildHeaderLine(
    glyph,
    input.name,
    presentation.summary,
    presentation.chips,
    input.durationMs,
    false,
  );

  if (presentation.bodyLines.length === 0) return header;

  // Body: 2-space indent (no character gutter). Errors get a subtle red bar.
  const indent = ok ? "  " : chalk.red("│ ");
  const body = presentation.bodyLines
    .map((raw) => `${indent}${colorDiffLine(raw.replace(/\s+$/, ""))}`)
    .join("\n");

  return `${header}\n${body}`;
}

/** Render the running header line (single line, used by spinner repaint). */
export function renderRunningHeader(
  name: string,
  args: Record<string, unknown>,
  frame: string,
  elapsedMs: number,
  presentation?: ToolPresentation,
): string {
  const pres = presentation ?? presentTool(name, args, null, true);
  const glyph = chalk.cyan(frame);
  return buildHeaderLine(
    glyph,
    name,
    pres.summary,
    pres.chips,
    elapsedMs,
    true,
  );
}

export interface ToolCardHandle {
  /** Stop the spinner and render the final card. Idempotent. */
  finish(state: CardState, result: string): void;
}

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const SPINNER_INTERVAL_MS = 100;

/**
 * Begin a live tool card. On a TTY, repaints a single-line spinner header in
 * place at ~10fps. On non-TTY, prints a static header line once. Always renders
 * the final card via console.log on finish().
 */
export function startToolCard(name: string, args: Record<string, unknown>): ToolCardHandle {
  const startedAt = Date.now();
  const isTTY = Boolean(process.stdout.isTTY);
  let finished = false;
  let frameIdx = 0;
  let timer: NodeJS.Timeout | null = null;

  const paint = (): void => {
    const elapsed = Date.now() - startedAt;
    const frame = SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length] ?? SPINNER_FRAMES[0];
    process.stdout.write(`\r\x1b[2K${renderRunningHeader(name, args, frame, elapsed)}`);
    frameIdx++;
  };

  if (isTTY) {
    paint();
    timer = setInterval(paint, SPINNER_INTERVAL_MS);
  } else {
    // Non-TTY: print one static header line, no spinner repaint.
    console.log(renderRunningHeader(name, args, SPINNER_FRAMES[0], 0));
  }

  const finish = (state: CardState, result: string): void => {
    if (finished) return;
    finished = true;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (isTTY) {
      process.stdout.write("\r\x1b[2K");
    }
    const durationMs = Date.now() - startedAt;
    console.log(renderToolCard({ name, args, state, result, durationMs }));
  };

  return { finish };
}
