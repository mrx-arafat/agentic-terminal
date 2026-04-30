import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandSuggestion, SessionState } from "../src/session.js";
import {
  pickSuggestion,
  handleRun,
  handleInsert,
  handleCopy,
} from "../src/suggestions.js";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

function makeSession(suggestions: CommandSuggestion[]): SessionState {
  return {
    startedAt: new Date(),
    provider: "test",
    model: "test-model",
    cwd: "/tmp",
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    alwaysAllow: new Set<string>(),
    turns: [],
    cancelled: false,
    yesUnsafe: false,
    suggestions,
  };
}

interface Capture {
  log: (line: string) => void;
  lines: string[];
}

function captureLog(): Capture {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(stripAnsi(line)) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pickSuggestion", () => {
  it("returns the first suggestion when arg is undefined", () => {
    const session = makeSession([
      { id: 1, lang: "bash", code: "echo a" },
      { id: 2, lang: "bash", code: "echo b" },
    ]);
    const r = pickSuggestion(session, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.suggestion.id).toBe(1);
  });

  it("rejects non-numeric arg", () => {
    const session = makeSession([{ id: 1, lang: "bash", code: "x" }]);
    const r = pickSuggestion(session, "abc");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/invalid suggestion id/);
  });
});

describe("/run", () => {
  it("errors when no suggestions exist", async () => {
    const cap = captureLog();
    const runShell = vi.fn(async () => undefined);
    await handleRun(makeSession([]), undefined, { runShell, log: cap.log });
    expect(runShell).not.toHaveBeenCalled();
    expect(cap.lines.join("\n")).toMatch(/no commands to run from the last reply/);
  });

  it("runs the only suggestion when arg omitted", async () => {
    const cap = captureLog();
    const runShell = vi.fn(async () => undefined);
    const session = makeSession([{ id: 1, lang: "bash", code: "echo hello" }]);
    await handleRun(session, undefined, { runShell, log: cap.log });
    expect(runShell).toHaveBeenCalledWith("echo hello");
    expect(cap.lines.join("\n")).toMatch(/running suggestion 1/);
  });

  it("selects suggestion #2 of 3", async () => {
    const cap = captureLog();
    const runShell = vi.fn(async () => undefined);
    const session = makeSession([
      { id: 1, lang: "bash", code: "echo one" },
      { id: 2, lang: "bash", code: "echo two" },
      { id: 3, lang: "bash", code: "echo three" },
    ]);
    await handleRun(session, "2", { runShell, log: cap.log });
    expect(runShell).toHaveBeenCalledWith("echo two");
  });

  it("errors with id range when n is out of bounds", async () => {
    const cap = captureLog();
    const runShell = vi.fn(async () => undefined);
    const session = makeSession([{ id: 1, lang: "bash", code: "x" }]);
    await handleRun(session, "99", { runShell, log: cap.log });
    expect(runShell).not.toHaveBeenCalled();
    expect(cap.lines.join("\n")).toMatch(/no suggestion with id 99 \(have: 1\.\.1\)/);
  });

  it("rejects non-numeric arg", async () => {
    const cap = captureLog();
    const runShell = vi.fn(async () => undefined);
    const session = makeSession([{ id: 1, lang: "bash", code: "x" }]);
    await handleRun(session, "abc", { runShell, log: cap.log });
    expect(runShell).not.toHaveBeenCalled();
    expect(cap.lines.join("\n")).toMatch(/invalid suggestion id/);
  });
});

describe("/insert", () => {
  it("errors when no suggestions exist", () => {
    const cap = captureLog();
    const setPendingInitial = vi.fn();
    handleInsert(makeSession([]), undefined, { setPendingInitial, log: cap.log });
    expect(setPendingInitial).not.toHaveBeenCalled();
    expect(cap.lines.join("\n")).toMatch(/no commands to run from the last reply/);
  });

  it("calls setPendingInitial with the selected code", () => {
    const cap = captureLog();
    const setPendingInitial = vi.fn();
    const session = makeSession([
      { id: 1, lang: "bash", code: "ls -la" },
      { id: 2, lang: "bash", code: "pwd" },
    ]);
    handleInsert(session, "1", { setPendingInitial, log: cap.log });
    expect(setPendingInitial).toHaveBeenCalledWith("ls -la");
    expect(cap.lines.join("\n")).toMatch(/ready to edit at next prompt/);
  });
});

describe("/copy", () => {
  it("writes OSC 52 with the suggestion's code in base64", () => {
    const cap = captureLog();
    const copy = vi.fn();
    const session = makeSession([{ id: 1, lang: "bash", code: "echo hi" }]);
    handleCopy(session, "1", { log: cap.log, env: { TERM_PROGRAM: "WarpTerminal" }, copy });
    expect(copy).toHaveBeenCalledWith("echo hi");
    expect(cap.lines.join("\n")).toMatch(/copied suggestion 1 to clipboard \(7 chars\)/);
  });

  it("shows the OSC-52 hint when TERM_PROGRAM is unset", () => {
    const cap = captureLog();
    const copy = vi.fn();
    const session = makeSession([{ id: 1, lang: "bash", code: "x" }]);
    handleCopy(session, "1", { log: cap.log, env: {}, copy });
    const out = cap.lines.join("\n");
    expect(out).toMatch(/copied suggestion 1/);
    expect(out).toMatch(/your terminal may not support OSC 52/);
  });

  it("does NOT show the hint when TERM_PROGRAM=WarpTerminal", () => {
    const cap = captureLog();
    const copy = vi.fn();
    const session = makeSession([{ id: 1, lang: "bash", code: "x" }]);
    handleCopy(session, "1", { log: cap.log, env: { TERM_PROGRAM: "WarpTerminal" }, copy });
    expect(cap.lines.join("\n")).not.toMatch(/may not support OSC 52/);
  });

  it("invokes the real OSC 52 escape via process.stdout when copy not provided", () => {
    const cap = captureLog();
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const session = makeSession([{ id: 1, lang: "bash", code: "echo hi" }]);
    handleCopy(session, "1", { log: cap.log, env: { TERM_PROGRAM: "WarpTerminal" } });
    expect(writeSpy).toHaveBeenCalledWith(`\x1b]52;c;${Buffer.from("echo hi", "utf8").toString("base64")}\x07`);
  });
});
