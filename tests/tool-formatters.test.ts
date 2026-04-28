import { describe, it, expect } from "vitest";
import { presentTool } from "../src/tool-formatters.js";

describe("presentTool — todo_write", () => {
  it("summarizes counts and renders task glyphs", () => {
    const result =
      "ok: 3 todo(s)\n  [x] design schema\n  [~] implement endpoint\n  [ ] write tests";
    const p = presentTool("todo_write", { todos: [] }, result, true);
    expect(p.summary).toBe("3 tasks · 1 done · 1 active");
    expect(p.chips).toEqual([]);
    expect(p.bodyLines).toEqual([
      "✓ design schema",
      "→ implement endpoint",
      "○ write tests",
    ]);
  });

  it("handles single task pluralization", () => {
    const p = presentTool("todo_write", {}, "ok: 1 todo(s)\n  [x] only one", true);
    expect(p.summary).toBe("1 task · 1 done · 0 active");
    expect(p.bodyLines).toEqual(["✓ only one"]);
  });

  it("running state shows placeholder summary", () => {
    const p = presentTool("todo_write", { todos: [] }, null, true);
    expect(p.summary).toBe("updating tasks…");
    expect(p.bodyLines).toEqual([]);
  });
});

describe("presentTool — read_file / read", () => {
  it("header-only on small successful read", () => {
    const result = "   1\thello\n   2\tworld";
    const p = presentTool("read_file", { path: "src/a.ts" }, result, true);
    expect(p.summary).toBe("src/a.ts");
    expect(p.bodyLines).toEqual([]);
    expect(p.chips).toEqual(["2 lines"]);
  });

  it("truncates long body to 4 + more marker", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `   ${i + 1}\tline ${i + 1}`).join("\n");
    const p = presentTool("read", { path: "x.txt" }, lines, true);
    expect(p.bodyLines.length).toBe(5);
    expect(p.bodyLines[4]).toMatch(/^… \d+ more$/);
    expect(p.chips).toEqual(["10 lines"]);
  });

  it("includes range in summary when offset/limit given", () => {
    const result = "  10\tfoo\n  11\tbar";
    const p = presentTool("read_file", { path: "f.ts", offset: 10, limit: 2 }, result, true);
    expect(p.summary).toBe("f.ts:10-12");
  });

  it("counts trailing 'more lines' marker into chip", () => {
    const result = "   1\tone\n   2\ttwo\n\n[… 50 more lines; call again with offset=2]";
    const p = presentTool("read_file", { path: "big.ts" }, result, true);
    expect(p.chips).toEqual(["52 lines"]);
  });

  it("running state produces no body or chips", () => {
    const p = presentTool("read_file", { path: "f.ts" }, null, true);
    expect(p.summary).toBe("f.ts");
    expect(p.bodyLines).toEqual([]);
    expect(p.chips).toEqual([]);
  });

  it("failure surfaces error in body", () => {
    const p = presentTool("read_file", { path: "missing.ts" }, "error: ENOENT no such file", false);
    expect(p.bodyLines[0]).toMatch(/^error:/);
  });
});

describe("presentTool — read_all", () => {
  it("chip shows file count", () => {
    const result = "read_all: 3 file(s) from src\n\n=== src/a.ts ===\nA\n\n=== src/b.ts ===\nB";
    const p = presentTool("read_all", { path: "src" }, result, true);
    expect(p.chips).toEqual(["3 files"]);
    expect(p.bodyLines.length).toBeGreaterThan(0);
  });

  it("failure surfaces error", () => {
    const p = presentTool("read_all", { path: "x" }, "error: ENOENT", false);
    expect(p.bodyLines[0]).toMatch(/error:/);
  });
});

describe("presentTool — write_file", () => {
  it("header-only success with +N chip", () => {
    const args = { path: "new.ts", content: "line1\nline2\nline3" };
    const p = presentTool("write_file", args, "ok: wrote 17 bytes to /abs/new.ts", true);
    expect(p.summary).toBe("new.ts");
    expect(p.bodyLines).toEqual([]);
    expect(p.chips).toEqual(["+3"]);
  });

  it("non-standard message renders body", () => {
    const args = { path: "f.ts", content: "x" };
    const p = presentTool("write_file", args, "warning: created with caveat\nextra info", true);
    expect(p.bodyLines.length).toBeGreaterThan(0);
  });

  it("failure shows error", () => {
    const p = presentTool("write_file", { path: "f.ts", content: "" }, "error: EACCES", false);
    expect(p.bodyLines[0]).toMatch(/error:/);
  });
});

describe("presentTool — edit_file / apply_patch / multi_edit", () => {
  it("header-only with stat estimated from old/new strings", () => {
    const args = { path: "f.ts", old_string: "foo", new_string: "bar\nbaz" };
    const p = presentTool("edit_file", args, "ok: replaced 1 occurrence in /abs/f.ts", true);
    expect(p.summary).toBe("f.ts");
    expect(p.bodyLines).toEqual([]);
    expect(p.chips).toEqual(["+1 -0"]);
  });

  it("apply_patch with diff syntax shows hunks first", () => {
    const diff = [
      "--- a/x",
      "+++ b/x",
      "@@ -1,3 +1,3 @@",
      " ctx",
      "-old",
      "+new",
      " end",
    ].join("\n");
    const p = presentTool("apply_patch", { path: "x" }, diff, true);
    expect(p.bodyLines[0]).toMatch(/^@@/);
    expect(p.chips[0]).toMatch(/^\+\d+ -\d+$/);
  });

  it("truncates long diff at 12 lines", () => {
    const lines = ["@@ -1,20 +1,20 @@"];
    for (let i = 0; i < 20; i++) lines.push(`+added ${i}`);
    const p = presentTool("apply_patch", { path: "x" }, lines.join("\n"), true);
    expect(p.bodyLines.length).toBe(13);
    expect(p.bodyLines[12]).toMatch(/^… \d+ more$/);
  });

  it("multi_edit succeeds header-only", () => {
    const args = { path: "f.ts", edits: [] };
    const p = presentTool("multi_edit", args, "ok: applied 2 edit(s) to /abs/f.ts", true);
    expect(p.bodyLines).toEqual([]);
  });

  it("failure surfaces error", () => {
    const p = presentTool("edit_file", { path: "f.ts", old_string: "x", new_string: "y" },
      "error: old_string not found in f.ts", false);
    expect(p.bodyLines[0]).toMatch(/error:/);
  });

  it("running state still computes stat chip", () => {
    const args = { path: "f.ts", old_string: "a\nb", new_string: "c" };
    const p = presentTool("edit_file", args, null, true);
    expect(p.chips).toEqual(["+0 -1"]);
  });
});

describe("presentTool — bash / run_command / shell", () => {
  it("truncates long command in summary", () => {
    const cmd = "echo " + "x".repeat(200);
    const p = presentTool("bash", { command: cmd }, "exit_code: 0\nstdout:\nx", true);
    expect(p.summary.length).toBeLessThanOrEqual(60);
    expect(p.summary.endsWith("…")).toBe(true);
  });

  it("happy path: exit chip + first stdout lines", () => {
    const out = ["exit_code: 0", "stdout:", "line a", "line b", "line c"].join("\n");
    const p = presentTool("bash", { command: "ls" }, out, true);
    expect(p.summary).toBe("ls");
    expect(p.chips).toEqual(["exit 0"]);
    expect(p.bodyLines).toContain("line a");
  });

  it("failure surfaces ALL stderr up to 16 lines", () => {
    const stderr = Array.from({ length: 25 }, (_, i) => `err line ${i}`).join("\n");
    const result = `exit_code: 1\nstdout:\n\nstderr:\n${stderr}`;
    const p = presentTool("bash", { command: "fail" }, result, false);
    expect(p.chips).toEqual(["exit 1"]);
    expect(p.bodyLines.length).toBeLessThanOrEqual(16);
    expect(p.bodyLines[0]).toBe("err line 0");
  });

  it("running state produces no body", () => {
    const p = presentTool("bash", { command: "sleep 5" }, null, true);
    expect(p.summary).toBe("sleep 5");
    expect(p.bodyLines).toEqual([]);
    expect(p.chips).toEqual([]);
  });

  it("background-start surfaces pid chip", () => {
    const result = "ok: started bg id=0 pid=4242 logPath=/x.log\ncommand: npm run dev";
    const p = presentTool("bash", { command: "npm run dev", background: true }, result, true);
    expect(p.chips).toEqual(["pid 4242"]);
  });

  it("run_command alias routes to bash formatter", () => {
    const p = presentTool("run_command", { command: "git status" }, "exit_code: 0\nstdout:\nclean", true);
    expect(p.chips).toEqual(["exit 0"]);
  });

  it("shell alias also routes to bash", () => {
    const p = presentTool("shell", { command: "pwd" }, "exit_code: 0\nstdout:\n/tmp", true);
    expect(p.chips).toEqual(["exit 0"]);
  });

  it("collapses blank-line runs in stdout", () => {
    const result = "exit_code: 0\nstdout:\nA\n\n\n\nB\n\n\nC";
    const p = presentTool("bash", { command: "x" }, result, true);
    expect(p.bodyLines.filter((l) => l === "")).toEqual([]);
  });
});

describe("presentTool — grep", () => {
  it("happy path: chip with totals and top hits", () => {
    const result = "matches: 3 in 2 file(s)\nsrc/a.ts:10:foo\nsrc/a.ts:20:foo\nsrc/b.ts:5:foo";
    const p = presentTool("grep", { pattern: "foo" }, result, true);
    expect(p.summary).toBe("foo");
    expect(p.chips[0]).toBe("3 matches in 2 files");
    expect(p.bodyLines.length).toBe(3);
  });

  it("zero matches → header-only with 0 chip", () => {
    const p = presentTool("grep", { pattern: "missing" }, "no matches for: missing", true);
    expect(p.bodyLines).toEqual([]);
    expect(p.chips).toEqual(["0 matches"]);
  });

  it("running state", () => {
    const p = presentTool("grep", { pattern: "x" }, null, true);
    expect(p.summary).toBe("x");
    expect(p.bodyLines).toEqual([]);
  });
});

describe("presentTool — glob / list_dir", () => {
  it("glob: chip with item count and capped entries", () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`).join("\n");
    const result = `files: 12\n${files}`;
    const p = presentTool("glob", { pattern: "src/**/*.ts" }, result, true);
    expect(p.chips).toEqual(["12 items"]);
    expect(p.bodyLines.length).toBe(9);
    expect(p.bodyLines[8]).toMatch(/^… \d+ more$/);
  });

  it("glob: zero-match path", () => {
    const p = presentTool("glob", { pattern: "nope" }, "no files match: nope", true);
    expect(p.chips).toEqual(["0 items"]);
    expect(p.bodyLines).toEqual([]);
  });

  it("list_dir: shows entries and chip", () => {
    const result = "a/\nb.txt\nc.ts";
    const p = presentTool("list_dir", { path: "." }, result, true);
    expect(p.chips).toEqual(["3 items"]);
    expect(p.bodyLines).toEqual(["a/", "b.txt", "c.ts"]);
  });

  it("list_dir: empty marker", () => {
    const p = presentTool("list_dir", { path: "empty/" }, "(empty)", true);
    expect(p.chips).toEqual(["0 items"]);
    expect(p.bodyLines).toEqual([]);
  });

  it("list_dir failure", () => {
    const p = presentTool("list_dir", { path: "x" }, "error: ENOENT", false);
    expect(p.bodyLines[0]).toMatch(/error:/);
  });
});

describe("presentTool — bg_*", () => {
  it("bg_logs surfaces pid chip from result", () => {
    const result = "bg id=0 pid=1234 running\n$ npm run dev\n---\nlog line 1\nlog line 2";
    const p = presentTool("bg_logs", { id: 0 }, result, true);
    expect(p.chips).toEqual(["pid 1234"]);
    expect(p.bodyLines.length).toBeGreaterThan(0);
  });

  it("bg_list with no pid still works", () => {
    const p = presentTool("bg_list", {}, "no background processes", true);
    expect(p.bodyLines).toEqual(["no background processes"]);
    expect(p.chips).toEqual([]);
  });

  it("bg_stop failure surfaces error", () => {
    const p = presentTool("bg_stop", { id: 99 }, "error: no bg process id=99", false);
    expect(p.bodyLines[0]).toMatch(/error:/);
  });
});

describe("presentTool — MCP-prefixed names", () => {
  it("colon-prefixed routes to MCP formatter, prefers query arg", () => {
    const p = presentTool("github:search_issues", { query: "bug label:p0", repo: "x/y" }, "issue #1\nissue #2", true);
    expect(p.summary).toBe("bug label:p0");
    expect(p.bodyLines).toContain("issue #1");
  });

  it("mcp_ prefix also routes to MCP formatter", () => {
    const p = presentTool("mcp__plugin_pilot_web-search__search", { query: "rust async" }, "result one", true);
    expect(p.summary).toBe("rust async");
  });

  it("falls back through name > id > path > first key", () => {
    const p = presentTool("a:b", { name: "thing", path: "/x" }, "ok", true);
    expect(p.summary).toBe("thing");
  });

  it("no preferred key — uses first scalar value", () => {
    const p = presentTool("a:b", { custom: "alpha" }, "x", true);
    expect(p.summary).toBe("alpha");
  });
});

describe("presentTool — generic fallback", () => {
  it("uses command/path/pattern/query/name priority", () => {
    const p = presentTool("unknown_tool", { command: "do thing", other: "ignored" }, "out", true);
    expect(p.summary).toBe("do thing");
  });

  it("falls back to JSON.stringify when no priority key matches", () => {
    const p = presentTool("unknown_tool", { weird: "value" }, "", true);
    expect(p.summary).toContain("weird");
    expect(p.summary).toContain("value");
  });

  it("empty args yields empty summary, no body", () => {
    const p = presentTool("unknown_tool", {}, "", true);
    expect(p.summary).toBe("");
    expect(p.bodyLines).toEqual([]);
    expect(p.chips).toEqual([]);
  });

  it("failure surfaces error", () => {
    const p = presentTool("unknown_tool", { name: "x" }, "error: bad", false);
    expect(p.bodyLines[0]).toMatch(/error:/);
  });

  it("body capped at 4 plus more marker", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `out ${i}`).join("\n");
    const p = presentTool("unknown_tool", { name: "x" }, lines, true);
    expect(p.bodyLines.length).toBe(5);
    expect(p.bodyLines[4]).toMatch(/^… \d+ more$/);
  });

  it("running state on unknown tool", () => {
    const p = presentTool("unknown_tool", { name: "task" }, null, true);
    expect(p.summary).toBe("task");
    expect(p.bodyLines).toEqual([]);
  });
});

describe("presentTool — robustness", () => {
  it("does not crash when args has no expected keys", () => {
    const p = presentTool("read_file", {}, "   1\thi", true);
    expect(p.summary).toBe("");
    expect(p.bodyLines).toEqual([]);
  });

  it("truncates 70-char-boundary summary correctly", () => {
    const p = presentTool("read_file", { path: "a".repeat(120) }, null, true);
    expect(p.summary.length).toBeLessThanOrEqual(70);
    expect(p.summary.endsWith("…")).toBe(true);
  });

  it("handles command exactly at boundary", () => {
    const cmd = "x".repeat(60);
    const p = presentTool("bash", { command: cmd }, "exit_code: 0", true);
    expect(p.summary).toBe(cmd);
    expect(p.summary.length).toBe(60);
  });

  it("handles command just over boundary", () => {
    const cmd = "x".repeat(61);
    const p = presentTool("bash", { command: cmd }, "exit_code: 0", true);
    expect(p.summary.length).toBe(60);
    expect(p.summary.endsWith("…")).toBe(true);
  });

  it("body lines are trimmed of trailing whitespace", () => {
    const result = "exit_code: 0\nstdout:\nhello   \nworld\t  ";
    const p = presentTool("bash", { command: "x" }, result, true);
    expect(p.bodyLines.every((l) => !/[ \t]$/.test(l))).toBe(true);
  });

  it("bash with unparseable exit emits 'done' chip", () => {
    const result = "stdout:\nsomething";
    const p = presentTool("bash", { command: "x" }, result, true);
    expect(p.chips).toEqual(["done"]);
  });
});
