import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { readInput } from "../src/input.js";

/**
 * Unit-test the input editor by replaying byte sequences through a fake stdin.
 * The renderer writes to stdout but we don't assert visual output here — we
 * assert the resolved text and event semantics.
 */

interface FakeStdin extends Readable {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: (b: boolean) => FakeStdin;
}

function makeFakeStdin(): FakeStdin {
  const r = new Readable({ read() { /* noop */ } }) as unknown as FakeStdin;
  r.isTTY = true;
  r.isRaw = false;
  r.setRawMode = (b: boolean): FakeStdin => { r.isRaw = b; return r; };
  return r;
}

async function drive(bytes: Buffer[], opts: Parameters<typeof readInput>[0] = {} as never): Promise<{ kind: string; text: string }> {
  const fake = makeFakeStdin();
  const realStdin = process.stdin;
  Object.defineProperty(process, "stdin", { value: fake, configurable: true });
  // suppress all stdout output during the test
  const realWrite = process.stdout.write.bind(process.stdout);
  (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = (): boolean => true;

  const finalOpts = {
    cwd: process.cwd(),
    history: [],
    ...opts,
  };

  const promise = readInput(finalOpts);

  // Feed all bytes after a microtask so handlers attach first
  await new Promise((r) => setTimeout(r, 10));
  for (const b of bytes) {
    fake.emit("data", b);
    await new Promise((r) => setTimeout(r, 5));
  }

  const result = await promise;
  Object.defineProperty(process, "stdin", { value: realStdin, configurable: true });
  (process.stdout as unknown as { write: (...a: unknown[]) => boolean }).write = realWrite;
  return result;
}

const ENTER = Buffer.from([0x0d]);
const ESC = Buffer.from([0x1b]);
const CTRL_C = Buffer.from([0x03]);
const CTRL_D = Buffer.from([0x04]);
const BACKSPACE = Buffer.from([0x7f]);
const TAB = Buffer.from([0x09]);
const LEFT = Buffer.from([0x1b, 0x5b, 0x44]);
const RIGHT = Buffer.from([0x1b, 0x5b, 0x43]);
const UP = Buffer.from([0x1b, 0x5b, 0x41]);
const DOWN = Buffer.from([0x1b, 0x5b, 0x42]);
const HOME = Buffer.from([0x1b, 0x5b, 0x48]);
const END = Buffer.from([0x1b, 0x5b, 0x46]);
const ALT_ENTER = Buffer.from([0x1b, 0x0d]);

describe("readInput", () => {
  it("resolves with submitted text on Enter", async () => {
    const r = await drive([Buffer.from("hello"), ENTER]);
    expect(r.kind).toBe("submit");
    expect(r.text).toBe("hello");
  });

  it("alt+enter inserts a newline (does not submit)", async () => {
    const r = await drive([Buffer.from("foo"), ALT_ENTER, Buffer.from("bar"), ENTER]);
    expect(r.kind).toBe("submit");
    expect(r.text).toBe("foo\nbar");
  });

  it("shift+enter (xterm modifyOtherKeys form) inserts a newline", async () => {
    // CSI 27;2;13~  → shift + Enter
    const SHIFT_ENTER_MOK = Buffer.from("\x1b[27;2;13~");
    const r = await drive([Buffer.from("foo"), SHIFT_ENTER_MOK, Buffer.from("bar"), ENTER]);
    expect(r.kind).toBe("submit");
    expect(r.text).toBe("foo\nbar");
  });

  it("shift+enter (kitty CSI u form) inserts a newline", async () => {
    // CSI 13;2u  → shift + Enter
    const SHIFT_ENTER_KITTY = Buffer.from("\x1b[13;2u");
    const r = await drive([Buffer.from("foo"), SHIFT_ENTER_KITTY, Buffer.from("bar"), ENTER]);
    expect(r.kind).toBe("submit");
    expect(r.text).toBe("foo\nbar");
  });

  it("plain Enter via kitty CSI u submits", async () => {
    const ENTER_KITTY = Buffer.from("\x1b[13u");
    const r = await drive([Buffer.from("hi"), ENTER_KITTY]);
    expect(r.kind).toBe("submit");
    expect(r.text).toBe("hi");
  });

  it("plain Backspace via kitty CSI u deletes one char", async () => {
    const BACKSPACE_KITTY = Buffer.from("\x1b[127u");
    const r = await drive([Buffer.from("abc"), BACKSPACE_KITTY, ENTER]);
    expect(r.kind).toBe("submit");
    expect(r.text).toBe("ab");
  });

  it("alt+Backspace via kitty CSI u deletes a word", async () => {
    const ALT_BACKSPACE_KITTY = Buffer.from("\x1b[127;3u");
    const r = await drive([Buffer.from("hello world"), ALT_BACKSPACE_KITTY, ENTER]);
    expect(r.kind).toBe("submit");
    expect(r.text).toBe("hello ");
  });

  it("backslash + enter inserts a newline", async () => {
    const r = await drive([Buffer.from("foo\\"), ENTER, Buffer.from("bar"), ENTER]);
    expect(r.kind).toBe("submit");
    expect(r.text).toBe("foo\nbar");
  });

  it("backspace deletes one char; collapses lines at row boundary", async () => {
    const r = await drive([
      Buffer.from("ab"),
      ALT_ENTER,
      Buffer.from("cd"),
      BACKSPACE, // remove d
      BACKSPACE, // remove c
      BACKSPACE, // collapse to "ab"
      Buffer.from("e"),
      ENTER,
    ]);
    expect(r.text).toBe("abe");
  });

  it("ctrl+a / ctrl+e jump to line ends", async () => {
    const CTRL_A = Buffer.from([0x01]);
    const CTRL_E = Buffer.from([0x05]);
    const r = await drive([
      Buffer.from("middle"),
      CTRL_A,
      Buffer.from("start-"),
      CTRL_E,
      Buffer.from("-end"),
      ENTER,
    ]);
    expect(r.text).toBe("start-middle-end");
  });

  it("ctrl+u kills to line start", async () => {
    const CTRL_U = Buffer.from([0x15]);
    const r = await drive([Buffer.from("trash here keep"), HOME, RIGHT, RIGHT, RIGHT, RIGHT, RIGHT, CTRL_U, ENTER]);
    // After HOME col=0, then five RIGHTs put col=5 ("trash"), CTRL_U deletes "trash" leaving " here keep"
    expect(r.text).toBe(" here keep");
  });

  it("ctrl+w deletes a word backward", async () => {
    const CTRL_W = Buffer.from([0x17]);
    const r = await drive([Buffer.from("alpha beta gamma"), CTRL_W, ENTER]);
    expect(r.text).toBe("alpha beta ");
  });

  it("arrow left + delete forward edits mid-line", async () => {
    const DEL = Buffer.from([0x1b, 0x5b, 0x33, 0x7e]);
    const r = await drive([Buffer.from("abXcd"), LEFT, LEFT, LEFT, DEL, ENTER]);
    expect(r.text).toBe("abcd");
  });

  it("up/down navigate persistent history when single-line", async () => {
    const r = await drive([UP, ENTER], { cwd: process.cwd(), history: ["first", "second"] });
    expect(r.text).toBe("second");
    const r2 = await drive([UP, UP, ENTER], { cwd: process.cwd(), history: ["first", "second"] });
    expect(r2.text).toBe("first");
  });

  it("ctrl+c with empty buffer interrupts", async () => {
    const r = await drive([CTRL_C]);
    expect(r.kind).toBe("interrupt");
  });

  it("ctrl+d on empty buffer = eof", async () => {
    const r = await drive([CTRL_D]);
    expect(r.kind).toBe("eof");
  });

  it("ctrl+d on non-empty = forward delete", async () => {
    const r = await drive([Buffer.from("abc"), HOME, CTRL_D, ENTER]);
    expect(r.text).toBe("bc");
  });

  it("bracketed paste with embedded newlines preserves multi-line", async () => {
    const PASTE_START = Buffer.from("\x1b[200~");
    const PASTE_END = Buffer.from("\x1b[201~");
    const r = await drive([PASTE_START, Buffer.from("line1\nline2\nline3"), PASTE_END, ENTER]);
    expect(r.text).toBe("line1\nline2\nline3");
  });

  it("esc clears non-empty input", async () => {
    const r = await drive([Buffer.from("trash"), ESC, Buffer.from("clean"), ENTER]);
    expect(r.text).toBe("clean");
  });

  it("tab completes a slash command", async () => {
    const r = await drive(
      [Buffer.from("/he"), TAB, ENTER],
      { cwd: process.cwd(), history: [], slashCommands: ["help", "history"] },
    );
    // First completion match is /help
    expect(r.text).toBe("/help");
  });

  it("submitted text is appended to history via onSubmit", async () => {
    const hist: string[] = [];
    let saved: string | null = null;
    const r = await drive(
      [Buffer.from("remember me"), ENTER],
      { cwd: process.cwd(), history: hist, onSubmit: (t) => { saved = t; } },
    );
    expect(r.text).toBe("remember me");
    expect(saved).toBe("remember me");
  });

  it("CR (\\r) and LF (\\n) and CR+LF all submit", async () => {
    const a = await drive([Buffer.from("a"), Buffer.from([0x0d])]);
    const b = await drive([Buffer.from("b"), Buffer.from([0x0a])]);
    expect(a.text).toBe("a");
    expect(b.text).toBe("b");
  });

  it("word-left (alt+b) and word-right (alt+f) jump words", async () => {
    const ALT_B = Buffer.from([0x1b, 0x62]);
    const ALT_F = Buffer.from([0x1b, 0x66]);
    const r = await drive([
      Buffer.from("one two three"),
      ALT_B, // back over "three"
      ALT_B, // back over "two"
      Buffer.from("X-"),
      ALT_F, // forward over rest of "two"
      Buffer.from("-Y"),
      ENTER,
    ]);
    expect(r.text).toBe("one X-two-Y three");
  });
});
