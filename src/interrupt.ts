import readline from "node:readline";

export interface EscInterruptState {
  isActive: () => boolean;
  onInterrupt: () => void;
}

export interface KeypressKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

type KeypressEmitter = NodeJS.ReadableStream & {
  on(event: "keypress" | "data", listener: (...a: unknown[]) => void): unknown;
  off(event: "keypress" | "data", listener: (...a: unknown[]) => void): unknown;
};

/** Decide whether a keypress should interrupt the in-flight turn. */
export function shouldInterrupt(key: KeypressKey | undefined, active: boolean): boolean {
  if (!active || !key) return false;
  if (key.ctrl || key.meta) return false;
  return key.name === "escape";
}

/** True when `buf` represents a plain Esc keystroke.
 *  Covers both \x1b (standard) and \x1b\x1b (terminals that send meta-prefixed
 *  ESC for the bare Esc key, and Alt sequences where the user just pressed
 *  Esc twice). Rejects CSI / SS3 sequences (arrows, F-keys). */
export function isBareEscape(buf: Buffer): boolean {
  if (buf.length === 0 || buf[0] !== 0x1b) return false;
  if (buf.length === 1) return true;
  if (buf.length === 2 && buf[1] === 0x1b) return true;
  return false;
}

const DEBUG = process.env.AGENTIC_DEBUG_KEYS === "1";

function hex(buf: Buffer): string {
  return Array.from(buf).map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/** Attach an Esc-to-interrupt listener to stdin. Returns a detach function.
 *
 *  Three layers of defense, firing in whichever order the terminal chooses:
 *   1. `keypress` event — cooked by readline, name==='escape' after the
 *      ~500ms escape-code disambiguation timeout.
 *   2. `data` event — raw bytes, matches \x1b or \x1b\x1b instantly.
 *   3. Forces raw mode on stdin when the turn goes active so bare Esc is
 *      delivered as a byte instead of being line-buffered until Enter.
 *
 *  All paths route through state.onInterrupt which must be idempotent
 *  (guard against double-abort at the caller). */
export function wireEscInterrupt(stdin: NodeJS.ReadableStream, state: EscInterruptState): () => void {
  readline.emitKeypressEvents(stdin as NodeJS.ReadStream);
  const emitter = stdin as KeypressEmitter;
  const tty = stdin as NodeJS.ReadStream;

  const wasRaw = tty.isTTY ? tty.isRaw === true : false;
  const tryRaw = (on: boolean): void => {
    if (!tty.isTTY) return;
    try { tty.setRawMode(on); } catch { /* ignore */ }
  };

  const keypressHandler = (_str: unknown, key: unknown): void => {
    const k = key as KeypressKey | undefined;
    if (DEBUG) process.stderr.write(`[dbg] keypress name=${k?.name} ctrl=${k?.ctrl} meta=${k?.meta} active=${state.isActive()}\n`);
    if (shouldInterrupt(k, state.isActive())) state.onInterrupt();
  };

  const dataHandler = (chunk: unknown): void => {
    const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === "string" ? Buffer.from(chunk) : null;
    if (!buf) return;
    if (DEBUG) process.stderr.write(`[dbg] data len=${buf.length} hex=${hex(buf)} active=${state.isActive()}\n`);
    if (!state.isActive()) return;
    if (isBareEscape(buf)) state.onInterrupt();
  };

  emitter.on("keypress", keypressHandler);
  emitter.on("data", dataHandler);

  // Ensure raw mode whenever a turn becomes active — without this, bare Esc is
  // line-buffered and never reaches us. Poll cheaply instead of exporting a
  // turn-state API to keep the wiring a single call site.
  const pollId = setInterval(() => {
    if (!tty.isTTY) return;
    if (state.isActive() && tty.isRaw !== true) tryRaw(true);
  }, 200);
  pollId.unref?.();

  // Make sure stdin is flowing — a prior child process or pty may have paused it.
  try { (stdin as { resume?: () => void }).resume?.(); } catch { /* ignore */ }

  return (): void => {
    clearInterval(pollId);
    emitter.off("keypress", keypressHandler);
    emitter.off("data", dataHandler);
    if (tty.isTTY && !wasRaw) tryRaw(false);
  };
}
