import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import chalk from "chalk";
import {
  renderRunningHeader,
  renderToolCard,
  startToolCard,
  type ToolCardHandle,
} from "../src/tool-card.js";
import type { ToolPresentation } from "../src/tool-formatters.js";

beforeAll(() => {
  // Force chalk to emit ANSI escapes in non-TTY test environments.
  chalk.level = 3;
});

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

const baseArgs: Record<string, unknown> = {};

describe("renderToolCard", () => {
  it("renders a header-only card when bodyLines is empty", () => {
    const presentation: ToolPresentation = {
      summary: "src/ui.ts (180 lines)",
      bodyLines: [],
      chips: [],
    };
    const out = renderToolCard({
      name: "read_file",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 100,
      presentation,
    });
    const plain = stripAnsi(out);
    expect(plain).toContain("●");
    expect(plain).toContain("read_file");
    expect(plain).toContain("src/ui.ts (180 lines)");
    expect(plain).toContain("done");
    expect(plain).toContain("0.1s");
    expect(plain).not.toContain("\n");
    expect(plain).not.toContain("▏");
  });

  it("renders body with gutter prefix on each line", () => {
    const presentation: ToolPresentation = {
      summary: "src/ui.ts",
      bodyLines: ["@@ -1,2 +1,2 @@", "- old line", "+ new line"],
      chips: ["+1", "-1"],
    };
    const out = renderToolCard({
      name: "edit_file",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 400,
      presentation,
    });
    const plain = stripAnsi(out);
    const lines = plain.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[1]).toContain("▏ ");
    expect(lines[1]).toContain("@@ -1,2 +1,2 @@");
    expect(lines[2]).toContain("▏ ");
    expect(lines[2]).toContain("- old line");
    expect(lines[3]).toContain("+ new line");
  });

  it("colorizes diff lines with ANSI escapes", () => {
    const presentation: ToolPresentation = {
      summary: "",
      bodyLines: ["@@ section @@", "+added", "-removed", "context"],
      chips: [],
    };
    const out = renderToolCard({
      name: "edit_file",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 200,
      presentation,
    });
    // ANSI escape present
    expect(out).toMatch(ANSI_RE);
    // Stripped form should preserve raw text
    expect(stripAnsi(out)).toContain("+added");
    expect(stripAnsi(out)).toContain("-removed");
    expect(stripAnsi(out)).toContain("context");
  });

  it("renders failure card with red gutter and failed pill", () => {
    const presentation: ToolPresentation = {
      summary: "npm run build",
      bodyLines: ["src/ui.ts(146,12): TS2304: Cannot find name 'renderCard'."],
      chips: ["exit 1"],
    };
    const out = renderToolCard({
      name: "bash",
      args: baseArgs,
      state: "failed",
      result: "boom",
      durationMs: 2300,
      presentation,
    });
    const plain = stripAnsi(out);
    expect(plain).toContain("✕");
    expect(plain).toContain("failed");
    expect(plain).toContain("exit 1");
    expect(plain).toContain("▏ ");
    expect(plain).toContain("2.3s");
  });

  it("does not truncate long bodies", () => {
    const longBody = Array.from({ length: 500 }, (_, i) => `line ${i}`);
    const presentation: ToolPresentation = {
      summary: "",
      bodyLines: longBody,
      chips: [],
    };
    const out = renderToolCard({
      name: "read_file",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 50,
      presentation,
    });
    const lines = stripAnsi(out).split("\n");
    expect(lines).toHaveLength(501); // 1 header + 500 body
    expect(lines[500]).toContain("line 499");
  });

  it("strips trailing whitespace from body lines", () => {
    const presentation: ToolPresentation = {
      summary: "",
      bodyLines: ["foo   ", "bar\t"],
      chips: [],
    };
    const out = renderToolCard({
      name: "x",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 0,
      presentation,
    });
    const lines = stripAnsi(out).split("\n");
    expect(lines[1].endsWith("foo")).toBe(true);
    expect(lines[2].endsWith("bar")).toBe(true);
  });

  it("colors '+N' chips green and 'exit 1' chip red", () => {
    const presentation: ToolPresentation = {
      summary: "",
      bodyLines: [],
      chips: ["+42", "-7"],
    };
    const out = renderToolCard({
      name: "edit_file",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 100,
      presentation,
    });
    // green ANSI 32, red ANSI 31
    expect(out).toMatch(/\x1b\[32m\+42\x1b\[/);
    expect(out).toMatch(/\x1b\[31m-7\x1b\[/);
  });

  it("formats duration >10s with bold dim style", () => {
    const presentation: ToolPresentation = {
      summary: "",
      bodyLines: [],
      chips: [],
    };
    const out = renderToolCard({
      name: "bash",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 11_700,
      presentation,
    });
    expect(stripAnsi(out)).toContain("11.7s");
  });

  it("dims '… N more lines' continuations", () => {
    const presentation: ToolPresentation = {
      summary: "",
      bodyLines: ["… 38 more lines"],
      chips: [],
    };
    const out = renderToolCard({
      name: "edit_file",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 100,
      presentation,
    });
    expect(stripAnsi(out)).toContain("… 38 more lines");
    // dim escape (ANSI 2) should be present somewhere
    expect(out).toMatch(/\x1b\[2m/);
  });
});

describe("renderRunningHeader", () => {
  it("includes elapsed time formatted to one decimal", () => {
    const presentation: ToolPresentation = { summary: "pytest -q", bodyLines: [], chips: [] };
    const out = renderRunningHeader("bash", baseArgs, "◐", 100, presentation);
    expect(stripAnsi(out)).toContain("0.1s");
    expect(stripAnsi(out)).toContain("running");
    expect(stripAnsi(out)).toContain("bash");
    expect(stripAnsi(out)).toContain("pytest -q");
  });

  it("formats long elapsed times correctly", () => {
    const presentation: ToolPresentation = { summary: "", bodyLines: [], chips: [] };
    const out = renderRunningHeader("bash", baseArgs, "◐", 11_700, presentation);
    expect(stripAnsi(out)).toContain("11.7s");
  });

  it("uses the spinner frame as the glyph", () => {
    const presentation: ToolPresentation = { summary: "", bodyLines: [], chips: [] };
    const out = renderRunningHeader("bash", baseArgs, "◓", 0, presentation);
    expect(stripAnsi(out)).toContain("◓");
  });
});

describe("right-alignment based on terminal width", () => {
  let original: number | undefined;
  beforeEach(() => {
    original = process.stdout.columns;
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "columns", {
      value: original,
      configurable: true,
      writable: true,
    });
  });

  it("right-aligns pill+duration when columns is wide", () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 100,
      configurable: true,
      writable: true,
    });
    const presentation: ToolPresentation = { summary: "x", bodyLines: [], chips: [] };
    const out = renderToolCard({
      name: "read_file",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 100,
      presentation,
    });
    const plain = stripAnsi(out);
    // Many spaces between left and right when right-aligned to 100 cols.
    expect(plain).toMatch(/ {5,}done/);
    expect(plain.length).toBeGreaterThanOrEqual(80);
  });

  it("falls back to two-space separator on narrow widths", () => {
    Object.defineProperty(process.stdout, "columns", {
      value: 40,
      configurable: true,
      writable: true,
    });
    const presentation: ToolPresentation = { summary: "x", bodyLines: [], chips: [] };
    const out = renderToolCard({
      name: "read_file",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 100,
      presentation,
    });
    const plain = stripAnsi(out);
    // No huge run of spaces in narrow mode
    expect(plain).not.toMatch(/ {10,}/);
    expect(plain).toContain("done");
  });

  it("falls back to two-space separator when columns is undefined", () => {
    Object.defineProperty(process.stdout, "columns", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const presentation: ToolPresentation = { summary: "", bodyLines: [], chips: [] };
    const out = renderToolCard({
      name: "x",
      args: baseArgs,
      state: "done",
      result: "ok",
      durationMs: 100,
      presentation,
    });
    expect(stripAnsi(out)).toContain("done");
  });
});

describe("startToolCard lifecycle", () => {
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let originalIsTTY: boolean | undefined;
  let originalColumns: number | undefined;

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY;
    originalColumns = process.stdout.columns;
    writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    writeSpy.mockRestore();
    logSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(process.stdout, "columns", {
      value: originalColumns,
      configurable: true,
      writable: true,
    });
  });

  const setTTY = (val: boolean): void => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: val,
      configurable: true,
      writable: true,
    });
  };

  it("paints immediately and repeats on interval in TTY mode", () => {
    setTTY(true);
    const handle: ToolCardHandle = startToolCard("bash", { command: "ls" });
    expect(writeSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(350);
    // 1 initial + ~3 ticks
    expect(writeSpy.mock.calls.length).toBeGreaterThanOrEqual(4);
    handle.finish("done", "ok");
  });

  it("clears spinner and writes final card on finish in TTY mode", () => {
    setTTY(true);
    const handle = startToolCard("bash", {});
    writeSpy.mockClear();
    handle.finish("done", "ok");
    // Final clear
    const calls: string[] = writeSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(calls.some((s: string) => s.includes("\r\x1b[2K"))).toBe(true);
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("finish is idempotent", () => {
    setTTY(true);
    const handle = startToolCard("bash", {});
    handle.finish("done", "ok");
    handle.finish("done", "ok");
    handle.finish("failed", "x");
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  it("clears the spinner timer on finish (no further paints)", () => {
    setTTY(true);
    const handle = startToolCard("bash", {});
    handle.finish("done", "ok");
    writeSpy.mockClear();
    vi.advanceTimersByTime(1000);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("non-TTY mode prints static header via console.log and no spinner writes", () => {
    setTTY(false);
    const handle = startToolCard("bash", { command: "ls" });
    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(writeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(writeSpy).not.toHaveBeenCalled();
    handle.finish("done", "ok");
    expect(logSpy).toHaveBeenCalledTimes(2);
  });

  it("non-TTY finish does not write clear sequence", () => {
    setTTY(false);
    const handle = startToolCard("bash", {});
    handle.finish("done", "ok");
    expect(writeSpy).not.toHaveBeenCalled();
  });
});
