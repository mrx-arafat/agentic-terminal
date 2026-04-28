import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import { buildCompletions } from "./shell.js";

// Belt-and-suspenders: if the process dies while kitty keyboard protocol is
// pushed, terminals stay in modified mode (broken keys for the user). The
// 'exit' event fires synchronously on any normal exit path. Idempotent.
let kittyKbdPushed = false;
function popKittyKbdIfNeeded(): void {
  if (!kittyKbdPushed) return;
  kittyKbdPushed = false;
  try { process.stdout.write("\x1b[<u"); } catch { /* ignore */ }
}
process.once("exit", popKittyKbdIfNeeded);

/** Result of one readInput() call. */
export interface InputResult {
  kind: "submit" | "eof" | "interrupt";
  text: string;
}

export interface InputOptions {
  cwd: string;
  branch?: string;
  history: string[];
  initial?: string;
  hintLines?: string[];
  /** Slash-command names for tab completion (without leading `/`). */
  slashCommands?: string[];
  /** Display name for header (e.g. "claude · sonnet-4"). */
  header?: string;
  /** Submitted-input handler called BEFORE resolve, used to persist history. */
  onSubmit?: (text: string) => void;
}

interface State {
  lines: string[];
  row: number;
  col: number;
  hist: string[];
  histIdx: number; // hist.length = current draft
  draft: string; // saved when navigating history
  innerWidth: number;
  prevTotalRows: number;
  prevCursorRow: number;
  message: string | null; // transient message under hint (e.g. "no more matches")
  completions: { matches: string[]; idx: number; tokenStart: number; tokenEnd: number; row: number } | null;
}

const ESC = "\x1b";
const CSI = `${ESC}[`;
const PASTE_START = `${CSI}200~`;
const PASTE_END = `${CSI}201~`;

type Key =
  | { kind: "char"; ch: string }
  | { kind: "ctrl"; ch: string }
  | { kind: "enter" }
  | { kind: "newline" }
  | { kind: "backspace" }
  | { kind: "delete" }
  | { kind: "tab" }
  | { kind: "shift-tab" }
  | { kind: "esc" }
  | { kind: "up" | "down" | "left" | "right" | "home" | "end" }
  | { kind: "word-left" | "word-right" | "word-delete-left" }
  | { kind: "paste"; text: string };

class KeyParser {
  private buf = "";
  private inPaste = false;
  private pasteAcc = "";

  feed(chunk: Buffer): Key[] {
    this.buf += chunk.toString("utf8");
    const out: Key[] = [];
    // Loop: try to consume at least one event per pass.
    // If we run out of bytes mid-sequence, leave the rest in this.buf.
    while (this.buf.length > 0) {
      if (this.inPaste) {
        const end = this.buf.indexOf(PASTE_END);
        if (end === -1) {
          this.pasteAcc += this.buf;
          this.buf = "";
          break;
        }
        this.pasteAcc += this.buf.slice(0, end);
        this.buf = this.buf.slice(end + PASTE_END.length);
        out.push({ kind: "paste", text: this.pasteAcc });
        this.pasteAcc = "";
        this.inPaste = false;
        continue;
      }

      const c = this.buf.charCodeAt(0);

      // Bracketed-paste start
      if (this.buf.startsWith(PASTE_START)) {
        this.buf = this.buf.slice(PASTE_START.length);
        this.inPaste = true;
        continue;
      }

      // ESC sequences
      if (c === 0x1b) {
        if (this.buf.length === 1) {
          // could be plain Esc or start of seq — wait briefly for more bytes
          // but we don't know — emit as Esc. If a real seq follows in a later
          // chunk, it'll start with another ESC and parse correctly.
          out.push({ kind: "esc" });
          this.buf = "";
          break;
        }
        const next = this.buf.charCodeAt(1);
        // ESC ESC → plain Esc (some terminals send this for bare ESC key)
        if (next === 0x1b) {
          out.push({ kind: "esc" });
          this.buf = this.buf.slice(2);
          continue;
        }
        // ESC + Enter / LF → newline
        if (next === 0x0d || next === 0x0a) {
          out.push({ kind: "newline" });
          this.buf = this.buf.slice(2);
          continue;
        }
        // ESC + DEL → word delete left (Alt+Backspace)
        if (next === 0x7f || next === 0x08) {
          out.push({ kind: "word-delete-left" });
          this.buf = this.buf.slice(2);
          continue;
        }
        // ESC b / ESC f → word-left / word-right (Alt+B / Alt+F)
        if (next === 0x62) { out.push({ kind: "word-left" }); this.buf = this.buf.slice(2); continue; }
        if (next === 0x66) { out.push({ kind: "word-right" }); this.buf = this.buf.slice(2); continue; }

        // CSI: ESC [
        if (next === 0x5b) {
          const csi = this.parseCSI(this.buf.slice(2));
          if (csi.needMore) break;
          if (csi.event) out.push(csi.event);
          this.buf = this.buf.slice(2 + csi.consumed);
          continue;
        }
        // SS3: ESC O — used by some terminals for arrows / function keys
        if (next === 0x4f) {
          if (this.buf.length < 3) break;
          const final = this.buf.charCodeAt(2);
          const k = ss3Final(final);
          if (k) out.push(k);
          this.buf = this.buf.slice(3);
          continue;
        }
        // ESC + plain char → treat as Alt+char; fall through as plain char of next byte
        // For now drop the ESC, treat following byte as char (Alt-prefix unused except above).
        // This means random Alt+letter inserts the letter.
        out.push({ kind: "char", ch: this.buf[1] });
        this.buf = this.buf.slice(2);
        continue;
      }

      // Control bytes
      if (c === 0x03) { out.push({ kind: "ctrl", ch: "c" }); this.buf = this.buf.slice(1); continue; }
      if (c === 0x04) { out.push({ kind: "ctrl", ch: "d" }); this.buf = this.buf.slice(1); continue; }
      if (c === 0x09) { out.push({ kind: "tab" }); this.buf = this.buf.slice(1); continue; }
      if (c === 0x0d || c === 0x0a) { out.push({ kind: "enter" }); this.buf = this.buf.slice(1); continue; }
      if (c === 0x7f || c === 0x08) { out.push({ kind: "backspace" }); this.buf = this.buf.slice(1); continue; }
      if (c >= 0x01 && c <= 0x1a) {
        // Ctrl+A..Z (skipping the special-cased ones above)
        const letter = String.fromCharCode(0x60 + c);
        out.push({ kind: "ctrl", ch: letter });
        this.buf = this.buf.slice(1);
        continue;
      }
      if (c < 0x20) { this.buf = this.buf.slice(1); continue; }

      // Printable: consume one full codepoint (UTF-8 already decoded by toString)
      const ch = this.buf[0];
      out.push({ kind: "char", ch });
      this.buf = this.buf.slice(1);
    }
    return out;
  }

  private parseCSI(rest: string): { event: Key | null; consumed: number; needMore: boolean } {
    // CSI = <params><final>; params = digits and ';' and possibly '?'/'<'/'>' prefix
    let i = 0;
    while (i < rest.length) {
      const code = rest.charCodeAt(i);
      const isParam = (code >= 0x30 && code <= 0x3f); // 0..9 : ; < = > ?
      if (isParam) { i++; continue; }
      // final byte
      const final = rest[i];
      const params = rest.slice(0, i);
      const consumed = i + 1;
      // Bracketed paste start/end handled at higher level via raw match — but
      // also catch here in case of fragmentation
      if (params === "200" && final === "~") {
        // shouldn't reach (matched at top); but be safe
        return { event: null, consumed, needMore: false };
      }
      const event = mapCSI(params, final);
      return { event, consumed, needMore: false };
    }
    return { event: null, consumed: 0, needMore: true };
  }
}

function mapCSI(params: string, final: string): Key | null {
  // Modifier-aware sequences are rare in this app; just map basic forms.
  switch (final) {
    case "A": return { kind: "up" };
    case "B": return { kind: "down" };
    case "C":
      if (params === "1;5" || params === "1;3") return { kind: "word-right" };
      return { kind: "right" };
    case "D":
      if (params === "1;5" || params === "1;3") return { kind: "word-left" };
      return { kind: "left" };
    case "H": return { kind: "home" };
    case "F": return { kind: "end" };
    case "Z": return { kind: "shift-tab" };
    case "~": {
      const parts = params.split(";");
      const n = parseInt(parts[0] ?? "", 10);
      if (n === 1 || n === 7) return { kind: "home" };
      if (n === 4 || n === 8) return { kind: "end" };
      if (n === 3) return { kind: "delete" };
      // xterm modifyOtherKeys=2: CSI 27;mod;code~ — shift+Enter (mod has shift bit)
      if (n === 27 && parts.length >= 3) {
        const mod = parseInt(parts[1] ?? "", 10);
        const code = parseInt(parts[2] ?? "", 10);
        if (code === 13 && Number.isFinite(mod) && (((mod - 1) & 1) !== 0)) {
          return { kind: "newline" };
        }
      }
      return null;
    }
    case "u": {
      // kitty keyboard protocol: CSI code[:shifted_code][;mod[:event]] u
      // We only care about code + base modifier here.
      const parts = params.split(";");
      const codeStr = (parts[0] ?? "").split(":")[0];
      const modStr = (parts[1] ?? "1").split(":")[0];
      const code = parseInt(codeStr, 10);
      const mod = parseInt(modStr, 10);
      if (!Number.isFinite(code)) return null;
      const bits = Number.isFinite(mod) ? mod - 1 : 0;
      const shift = (bits & 1) !== 0;
      const alt = (bits & 2) !== 0;
      const ctrl = (bits & 4) !== 0;
      // Enter
      if (code === 13) return (shift || alt) ? { kind: "newline" } : { kind: "enter" };
      // Tab / Shift+Tab
      if (code === 9) return shift ? { kind: "shift-tab" } : { kind: "tab" };
      // Backspace; alt/ctrl variant deletes word
      if (code === 127 || code === 8) return (alt || ctrl) ? { kind: "word-delete-left" } : { kind: "backspace" };
      // Esc
      if (code === 27) return { kind: "esc" };
      // Arrows / nav (when terminal funnels through CSI u with modifiers)
      if (code === 57352 || code === 57353) return { kind: alt || ctrl ? (code === 57352 ? "word-left" : "word-right") : (code === 57352 ? "left" : "right") };
      // Ctrl+letter
      if (ctrl && !alt && code >= 0x61 && code <= 0x7a) return { kind: "ctrl", ch: String.fromCharCode(code) };
      // Alt+b / Alt+f for word nav
      if (alt && !ctrl && code === 0x62) return { kind: "word-left" };
      if (alt && !ctrl && code === 0x66) return { kind: "word-right" };
      // Plain printable char (possibly with shift only) → insert
      if (!ctrl && !alt && code >= 0x20 && code < 0x7f) return { kind: "char", ch: String.fromCharCode(code) };
      return null;
    }
    default:
      return null;
  }
}

function ss3Final(code: number): Key | null {
  switch (code) {
    case 0x41: return { kind: "up" };
    case 0x42: return { kind: "down" };
    case 0x43: return { kind: "right" };
    case 0x44: return { kind: "left" };
    case 0x48: return { kind: "home" };
    case 0x46: return { kind: "end" };
    default: return null;
  }
}

function shortCwd(cwd: string): string {
  const home = os.homedir();
  return cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
}

function visualLen(s: string): number {
  // strip ANSI escapes for width calc
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function truncate(s: string, w: number): string {
  if (visualLen(s) <= w) return s;
  return s.slice(0, Math.max(0, w - 1)) + "…";
}

function visibleLine(line: string, col: number, inner: number): { text: string; displayCol: number } {
  if (line.length <= inner) return { text: line.padEnd(inner), displayCol: col };
  // horizontal scroll window keeping cursor visible
  let start = 0;
  if (col >= inner - 4) start = col - (inner - 4);
  if (start + inner > line.length + 1) start = Math.max(0, line.length - inner + 1);
  const end = Math.min(line.length, start + inner);
  let text = line.slice(start, end);
  if (start > 0) text = "…" + text.slice(1);
  if (end < line.length) text = text.slice(0, Math.max(0, text.length - 1)) + "…";
  return { text: text.padEnd(inner), displayCol: col - start };
}

function tokenAtCursor(line: string, col: number): { start: number; end: number; text: string } {
  let start = col;
  while (start > 0 && !/\s/.test(line[start - 1])) start--;
  let end = col;
  while (end < line.length && !/\s/.test(line[end])) end++;
  return { start, end, text: line.slice(start, end) };
}

function getCompletions(line: string, col: number, cwd: string, slashCommands: string[]): { matches: string[]; tokenStart: number; tokenEnd: number } {
  const tok = tokenAtCursor(line, col);
  // Slash command at start of line
  if (line.trimStart().startsWith("/") && tok.start === line.indexOf("/")) {
    const prefix = tok.text.slice(1);
    const matches = slashCommands.filter((c) => c.startsWith(prefix)).map((c) => "/" + c);
    return { matches, tokenStart: tok.start, tokenEnd: tok.end };
  }
  // @ file completion
  if (tok.text.startsWith("@")) {
    const inner = tok.text.slice(1);
    const [paths] = buildCompletions(inner, cwd);
    return { matches: paths.map((p) => "@" + p), tokenStart: tok.start, tokenEnd: tok.end };
  }
  // generic path completion on the token at cursor
  const [paths] = buildCompletions(tok.text, cwd);
  return { matches: paths, tokenStart: tok.start, tokenEnd: tok.end };
}

function findHistoryMatch(history: string[], prefix: string, fromIdx: number, dir: -1 | 1): number {
  if (!prefix) {
    const next = fromIdx + dir;
    if (next < 0) return 0;
    if (next > history.length) return history.length;
    return next;
  }
  let i = fromIdx + dir;
  while (i >= 0 && i < history.length) {
    if (history[i].startsWith(prefix)) return i;
    i += dir;
  }
  return fromIdx;
}

function termWidth(): number {
  return Math.max(40, Math.min(process.stdout.columns ?? 100, 120));
}

function renderBox(state: State, opts: InputOptions): { output: string; cursorUp: number; cursorCol: number } {
  const w = termWidth();
  // Box layout per content row: │ space marker space TEXT space │
  // Fixed chars: 6. Text capacity = w - 6.
  const textCap = Math.max(10, w - 6);
  state.innerWidth = textCap;

  const headerLeft = chalk.gray(" ") + chalk.cyan(shortCwd(opts.cwd));
  const headerRight = opts.branch ? chalk.yellow(`git:(${opts.branch})`) + " " : " ";
  const headerCenter = opts.header ? chalk.gray(" · ") + chalk.gray(opts.header) : "";
  const headerText = headerLeft + headerCenter + " ";
  const headerVis = visualLen(headerText) + visualLen(headerRight);
  const fillCount = Math.max(0, w - 2 - headerVis);
  const top = chalk.gray("╭") + headerText + chalk.gray("─".repeat(fillCount)) + headerRight + chalk.gray("╮");

  const bot = chalk.gray("╰" + "─".repeat(w - 2) + "╯");
  const side = chalk.gray("│");

  const visibleLines: { text: string; displayCol: number }[] = state.lines.map((ln, i) => {
    if (i === state.row) return visibleLine(ln, state.col, textCap);
    return { text: truncate(ln, textCap).padEnd(textCap), displayCol: 0 };
  });

  const out: string[] = [];
  out.push(top);
  for (let i = 0; i < visibleLines.length; i++) {
    const { text } = visibleLines[i];
    const marker = i === 0 ? chalk.cyan("›") : chalk.gray("·");
    out.push(side + " " + marker + " " + text + " " + side);
  }
  out.push(bot);

  if (state.completions && state.completions.matches.length > 1) {
    const list = state.completions.matches;
    const cur = state.completions.idx;
    const max = 6;
    const window = list.slice(0, max);
    const more = list.length > max ? chalk.gray(` (+${list.length - max} more)`) : "";
    const display = window.map((m, i) => i === cur ? chalk.bgGray.black(" " + m + " ") : chalk.gray(" " + m + " ")).join(" ");
    out.push(chalk.gray("  ↹ ") + display + more);
  } else if (opts.hintLines && opts.hintLines.length > 0) {
    for (const h of opts.hintLines) out.push(chalk.gray("  " + h));
  }

  if (state.message) out.push(chalk.yellow("  " + state.message));

  const totalRows = out.length;
  // cursor lives in row index `1 + state.row` (0 = top border)
  const cursorRowFromTop = 1 + state.row;
  // text starts at terminal column: │ + space + marker + space = 4 (1-indexed)
  const textStartCol = 5;
  const cursorVisCol = visibleLines[state.row].displayCol;
  const cursorTermCol = textStartCol + cursorVisCol;

  // After printing all rows joined with \n (no trailing \n), terminal cursor is
  // at end of last row. We need to move it to the input row.
  const cursorUp = (totalRows - 1) - cursorRowFromTop;
  state.prevTotalRows = totalRows;
  state.prevCursorRow = cursorRowFromTop;

  return { output: out.join("\n"), cursorUp, cursorCol: cursorTermCol };
}

function clearPrevious(state: State): string {
  if (state.prevTotalRows === 0) return "";
  // current cursor is at (prevCursorRow + 1) from top of render (1-indexed).
  // To get to row 0 (top), move up prevCursorRow lines.
  const up = state.prevCursorRow;
  return (up > 0 ? `${CSI}${up}A` : "") + `\r${CSI}J`;
}

/** Read one user submission with full multi-line editing. */
export async function readInput(opts: InputOptions): Promise<InputResult> {
  const tty = process.stdin as NodeJS.ReadStream;
  const isTTY = !!tty.isTTY;
  if (!isTTY) {
    // Non-TTY fallback: read one line as plain text.
    return readSingleLineFallback();
  }

  const initial = opts.initial ?? "";
  const startLines = initial.length === 0 ? [""] : initial.split("\n");
  const startRow = startLines.length - 1;
  const startCol = startLines[startRow].length;

  const state: State = {
    lines: startLines,
    row: startRow,
    col: startCol,
    hist: opts.history,
    histIdx: opts.history.length,
    draft: initial,
    innerWidth: 0,
    prevTotalRows: 0,
    prevCursorRow: 0,
    message: null,
    completions: null,
  };

  const parser = new KeyParser();
  const wasRaw = tty.isRaw === true;
  const stdoutWrite = (s: string): void => { process.stdout.write(s); };

  // Enable bracketed paste so multi-line pastes don't auto-submit at first \n.
  // Push kitty keyboard protocol (level 1: disambiguate) so shift+enter etc.
  // emit distinct CSI u sequences. Terminals without support ignore it.
  stdoutWrite(`${CSI}?2004h${CSI}>1u`);
  kittyKbdPushed = true;
  tty.setRawMode(true);
  tty.resume();

  const cleanup = (): void => {
    // Pop kitty keyboard protocol, then disable bracketed paste.
    stdoutWrite(`${CSI}<u${CSI}?2004l`);
    kittyKbdPushed = false;
    if (!wasRaw) tty.setRawMode(false);
  };

  const repaint = (): void => {
    const erase = clearPrevious(state);
    const r = renderBox(state, opts);
    let out = erase + r.output;
    if (r.cursorUp > 0) out += `${CSI}${r.cursorUp}A`;
    out += `\r${CSI}${r.cursorCol}G`;
    stdoutWrite(out);
  };

  const finalRender = (text: string): void => {
    // Erase the box and replace with a compact "submitted" line so transcript
    // stays clean. If the user cancelled, just clear.
    stdoutWrite(clearPrevious(state));
    state.prevTotalRows = 0;
    state.prevCursorRow = 0;
    if (text) {
      const preview = text.split("\n").map((l, i) => i === 0 ? chalk.cyan("› ") + l : chalk.gray("  ") + l).join("\n");
      stdoutWrite(preview + "\n");
    }
  };

  return new Promise<InputResult>((resolve) => {
    let resolved = false;
    const finish = (result: InputResult, showSubmitted: boolean): void => {
      if (resolved) return;
      resolved = true;
      tty.off("data", onData);
      if (showSubmitted) finalRender(result.text);
      else { stdoutWrite(clearPrevious(state)); }
      cleanup();
      if (opts.onSubmit && result.kind === "submit" && result.text.trim().length > 0) {
        try { opts.onSubmit(result.text); } catch { /* ignore */ }
      }
      resolve(result);
    };

    const currentText = (): string => state.lines.join("\n");
    const setText = (t: string, putAtEnd = true): void => {
      state.lines = t.length === 0 ? [""] : t.split("\n");
      if (putAtEnd) {
        state.row = state.lines.length - 1;
        state.col = state.lines[state.row].length;
      } else {
        state.row = Math.min(state.row, state.lines.length - 1);
        state.col = Math.min(state.col, state.lines[state.row].length);
      }
      state.completions = null;
    };

    const insertChar = (ch: string): void => {
      if (ch === "\n") { splitLine(); return; }
      const ln = state.lines[state.row];
      state.lines[state.row] = ln.slice(0, state.col) + ch + ln.slice(state.col);
      state.col += ch.length;
      state.completions = null;
    };

    const splitLine = (): void => {
      const ln = state.lines[state.row];
      const before = ln.slice(0, state.col);
      const after = ln.slice(state.col);
      state.lines[state.row] = before;
      state.lines.splice(state.row + 1, 0, after);
      state.row += 1;
      state.col = 0;
      state.completions = null;
    };

    const backspace = (): void => {
      if (state.col === 0) {
        if (state.row === 0) return;
        const prev = state.lines[state.row - 1];
        const cur = state.lines[state.row];
        state.lines[state.row - 1] = prev + cur;
        state.lines.splice(state.row, 1);
        state.row -= 1;
        state.col = prev.length;
      } else {
        const ln = state.lines[state.row];
        state.lines[state.row] = ln.slice(0, state.col - 1) + ln.slice(state.col);
        state.col -= 1;
      }
      state.completions = null;
    };

    const deleteForward = (): void => {
      const ln = state.lines[state.row];
      if (state.col === ln.length) {
        if (state.row === state.lines.length - 1) return;
        const next = state.lines[state.row + 1];
        state.lines[state.row] = ln + next;
        state.lines.splice(state.row + 1, 1);
      } else {
        state.lines[state.row] = ln.slice(0, state.col) + ln.slice(state.col + 1);
      }
      state.completions = null;
    };

    const wordDeleteLeft = (): void => {
      const ln = state.lines[state.row];
      if (state.col === 0) { backspace(); return; }
      let i = state.col;
      while (i > 0 && /\s/.test(ln[i - 1])) i--;
      while (i > 0 && !/\s/.test(ln[i - 1])) i--;
      state.lines[state.row] = ln.slice(0, i) + ln.slice(state.col);
      state.col = i;
      state.completions = null;
    };

    const moveLeft = (): void => {
      if (state.col > 0) state.col--;
      else if (state.row > 0) { state.row--; state.col = state.lines[state.row].length; }
    };
    const moveRight = (): void => {
      if (state.col < state.lines[state.row].length) state.col++;
      else if (state.row < state.lines.length - 1) { state.row++; state.col = 0; }
    };
    const wordLeft = (): void => {
      const ln = state.lines[state.row];
      if (state.col === 0) { moveLeft(); return; }
      let i = state.col;
      while (i > 0 && /\s/.test(ln[i - 1])) i--;
      while (i > 0 && !/\s/.test(ln[i - 1])) i--;
      state.col = i;
    };
    const wordRight = (): void => {
      const ln = state.lines[state.row];
      if (state.col === ln.length) { moveRight(); return; }
      let i = state.col;
      while (i < ln.length && /\s/.test(ln[i])) i++;
      while (i < ln.length && !/\s/.test(ln[i])) i++;
      state.col = i;
    };

    const navigateHistory = (dir: -1 | 1): void => {
      if (state.hist.length === 0) return;
      const cur = currentText();
      // First Up press from a fresh draft saves the draft.
      if (state.histIdx === state.hist.length) state.draft = cur;
      const prefix = state.draft;
      const next = findHistoryMatch(state.hist, prefix, state.histIdx, dir);
      if (next === state.histIdx) return;
      state.histIdx = next;
      const text = state.histIdx === state.hist.length ? state.draft : state.hist[state.histIdx];
      setText(text, true);
    };

    const tryComplete = (): void => {
      if (state.completions && state.completions.row === state.row) {
        // cycle
        const c = state.completions;
        c.idx = (c.idx + 1) % c.matches.length;
        applyCompletion();
        return;
      }
      const ln = state.lines[state.row];
      const { matches, tokenStart, tokenEnd } = getCompletions(ln, state.col, opts.cwd, opts.slashCommands ?? []);
      if (matches.length === 0) {
        state.message = "no completions";
        setTimeout(() => { state.message = null; repaint(); }, 700);
        return;
      }
      state.completions = { matches, idx: 0, tokenStart, tokenEnd, row: state.row };
      applyCompletion();
    };

    const applyCompletion = (): void => {
      if (!state.completions) return;
      const c = state.completions;
      const ln = state.lines[state.row];
      const replacement = c.matches[c.idx];
      state.lines[state.row] = ln.slice(0, c.tokenStart) + replacement + ln.slice(c.tokenEnd);
      state.col = c.tokenStart + replacement.length;
      c.tokenEnd = state.col;
    };

    const handleKey = (k: Key): void => {
      // Any non-tab keystroke clears completion list
      if (k.kind !== "tab" && k.kind !== "shift-tab") state.completions = null;

      switch (k.kind) {
        case "char":
          insertChar(k.ch);
          break;
        case "paste":
          // Insert paste verbatim, splitting on newlines
          for (const ch of k.text) insertChar(ch === "\r" ? "\n" : ch);
          break;
        case "enter": {
          // backslash-continuation: line ends with `\`
          const ln = state.lines[state.row];
          if (ln.endsWith("\\") && state.col === ln.length) {
            state.lines[state.row] = ln.slice(0, -1);
            state.col = state.lines[state.row].length;
            splitLine();
            break;
          }
          // Submit
          finish({ kind: "submit", text: currentText() }, true);
          return;
        }
        case "newline":
          splitLine();
          break;
        case "backspace":
          backspace();
          break;
        case "delete":
          deleteForward();
          break;
        case "word-delete-left":
          wordDeleteLeft();
          break;
        case "left": moveLeft(); break;
        case "right": moveRight(); break;
        case "word-left": wordLeft(); break;
        case "word-right": wordRight(); break;
        case "home": state.col = 0; break;
        case "end": state.col = state.lines[state.row].length; break;
        case "up":
          if (state.row > 0 && state.lines.length > 1) { state.row--; state.col = Math.min(state.col, state.lines[state.row].length); }
          else navigateHistory(-1);
          break;
        case "down":
          if (state.row < state.lines.length - 1) { state.row++; state.col = Math.min(state.col, state.lines[state.row].length); }
          else navigateHistory(1);
          break;
        case "tab": tryComplete(); break;
        case "shift-tab":
          if (state.completions && state.completions.matches.length > 1) {
            const c = state.completions;
            c.idx = (c.idx - 1 + c.matches.length) % c.matches.length;
            applyCompletion();
          }
          break;
        case "esc":
          // Clear current input if non-empty; otherwise no-op (turn-interrupt is wired elsewhere)
          if (currentText().length > 0) {
            setText("", true);
          }
          break;
        case "ctrl":
          switch (k.ch) {
            case "c":
              finish({ kind: "interrupt", text: currentText() }, false);
              return;
            case "d":
              if (currentText().length === 0) {
                finish({ kind: "eof", text: "" }, false);
                return;
              }
              deleteForward();
              break;
            case "a": state.col = 0; break;
            case "e": state.col = state.lines[state.row].length; break;
            case "k":
              state.lines[state.row] = state.lines[state.row].slice(0, state.col);
              break;
            case "u":
              state.lines[state.row] = state.lines[state.row].slice(state.col);
              state.col = 0;
              break;
            case "w": wordDeleteLeft(); break;
            case "l":
              stdoutWrite(`${CSI}2J${CSI}H`);
              state.prevTotalRows = 0;
              state.prevCursorRow = 0;
              break;
            case "n": navigateHistory(1); break;
            case "p": navigateHistory(-1); break;
            case "b": moveLeft(); break;
            case "f": moveRight(); break;
          }
          break;
      }
      repaint();
    };

    const onData = (chunk: Buffer): void => {
      try {
        const events = parser.feed(chunk);
        for (const e of events) {
          handleKey(e);
          if (resolved) return;
        }
      } catch (err) {
        finish({ kind: "interrupt", text: "" }, false);
      }
    };

    tty.on("data", onData);
    repaint();
  });
}

async function readSingleLineFallback(): Promise<InputResult> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (d: Buffer): void => {
      buf += d.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        process.stdin.off("data", onData);
        resolve({ kind: "submit", text: buf.slice(0, nl).trim() });
      }
    };
    process.stdin.on("data", onData);
    process.stdin.once("end", () => {
      process.stdin.off("data", onData);
      resolve({ kind: "eof", text: buf.trim() });
    });
  });
}

/** Persistent history, capped at MAX_HIST lines. */
const MAX_HIST = 1000;

export function historyPath(): string {
  return path.join(os.homedir(), ".config", "agentic-terminal", "history");
}

export function loadHistory(): string[] {
  try {
    const text = fs.readFileSync(historyPath(), "utf8");
    return text.split("\n").map((l) => l.replace(/\\n/g, "\n")).filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

export function appendHistory(history: string[], entry: string): void {
  const trimmed = entry.trim();
  if (!trimmed) return;
  if (history[history.length - 1] === trimmed) return;
  history.push(trimmed);
  while (history.length > MAX_HIST) history.shift();
  try {
    const file = historyPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const encoded = history.map((l) => l.replace(/\n/g, "\\n")).join("\n") + "\n";
    fs.writeFileSync(file, encoded, "utf8");
  } catch {
    // best-effort persistence
  }
}
