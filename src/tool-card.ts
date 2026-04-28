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

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const visibleLength = (s: string): number => s.replace(ANSI_RE, "").length;

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

const colorDiffLine = (line: string): string => {
  if (line.startsWith("@@")) return chalk.cyan(line);
  if (line.startsWith("+++") || line.startsWith("---")) return line;
  if (line.startsWith("+")) return chalk.green(line);
  if (line.startsWith("-")) return chalk.red(line);
  if (line.startsWith("… ") || line === "…") return chalk.dim(line);
  return line;
};

const buildHeaderLine = (
  glyph: string,
  name: string,
  summary: string,
  chips: string[],
  pillText: string,
  pillColor: (s: string) => string,
  durationMs: number,
): string => {
  const left: string[] = [glyph, " ", chalk.bold(name)];
  if (summary.length > 0) left.push("  ", chalk.gray(summary));
  if (chips.length > 0) left.push("  ", renderChips(chips));

  const durStr = formatDuration(durationMs);
  const dur = durationMs > 10_000 ? chalk.bold.dim(durStr) : chalk.dim(durStr);
  const right = `${pillColor(pillText)} ${chalk.dim("·")} ${dur}`;

  const leftStr = left.join("");
  const cols = process.stdout.columns;
  if (typeof cols === "number" && cols >= 60) {
    const used = visibleLength(leftStr) + visibleLength(right);
    const pad = Math.max(2, cols - used);
    return `${leftStr}${" ".repeat(pad)}${right}`;
  }
  return `${leftStr}  ${right}`;
};

/** Render a complete tool card (header + body) to a string. No trailing newline. */
export function renderToolCard(input: RenderCardInput): string {
  const ok = input.state === "done";
  const presentation =
    input.presentation ?? presentTool(input.name, input.args, input.result, ok);

  const glyph = ok ? chalk.green("●") : chalk.red("✕");
  const pillText = ok ? "done" : "failed";
  const pillColor = ok ? chalk.green : chalk.red;

  const header = buildHeaderLine(
    glyph,
    input.name,
    presentation.summary,
    presentation.chips,
    pillText,
    pillColor,
    input.durationMs,
  );

  if (presentation.bodyLines.length === 0) return header;

  const gutter = ok ? chalk.gray("▏ ") : chalk.red("▏ ");
  const body = presentation.bodyLines
    .map((raw) => `${gutter}${colorDiffLine(raw.replace(/\s+$/, ""))}`)
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
    "running",
    chalk.cyan,
    elapsedMs,
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
