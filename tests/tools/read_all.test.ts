import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_HANDLERS, type ToolContext } from "../../src/tools.js";
import type { BlockRecord, TodoItem } from "../../src/blocks.js";

function makeCtx(cwd: string): ToolContext {
  return {
    cwd,
    readPaths: new Set<string>(),
    blocks: [] as BlockRecord[],
    todos: [] as TodoItem[],
  };
}

let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "at-readall-"));
  // top-level
  fs.writeFileSync(path.join(tmp, "README.md"), "# hello\n");
  fs.writeFileSync(path.join(tmp, "app.js"), "console.log('x')\n");
  // nested files (second-order reasoning)
  fs.mkdirSync(path.join(tmp, "files"));
  fs.writeFileSync(path.join(tmp, "files", "one.txt"), "first\n");
  fs.writeFileSync(path.join(tmp, "files", "two.txt"), "second\n");
  // nested deeper
  fs.mkdirSync(path.join(tmp, "files", "deep"));
  fs.writeFileSync(path.join(tmp, "files", "deep", "three.py"), "print(3)\n");
  // should be skipped
  fs.mkdirSync(path.join(tmp, "node_modules"));
  fs.writeFileSync(path.join(tmp, "node_modules", "junk.js"), "nope\n");
  fs.writeFileSync(path.join(tmp, ".DS_Store"), "binary-ish");
  // binary file (NUL byte)
  fs.writeFileSync(path.join(tmp, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
});

describe("read_all", () => {
  it("recurses and returns concatenated text with headers", async () => {
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.read_all({}, ctx);
    expect(out).toMatch(/read_all: \d+ file\(s\)/);
    expect(out).toContain("=== README.md");
    expect(out).toContain("# hello");
    expect(out).toContain("=== app.js");
    expect(out).toContain("=== files/one.txt");
    expect(out).toContain("first");
    expect(out).toContain("=== files/deep/three.py");
    expect(out).toContain("print(3)");
  });

  it("skips node_modules and .DS_Store by default", async () => {
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.read_all({}, ctx);
    expect(out).not.toContain("node_modules");
    expect(out).not.toContain(".DS_Store");
  });

  it("skips binary files", async () => {
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.read_all({}, ctx);
    expect(out).not.toContain("=== bin.dat");
    expect(out).toMatch(/skipped \d+ binary/);
  });

  it("respects max_files", async () => {
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.read_all({ max_files: 2 }, ctx);
    expect(out).toMatch(/read_all: 2 file\(s\)/);
    expect(out).toMatch(/more not shown/);
  });

  it("handles single-file input as read_file", async () => {
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.read_all({ path: "README.md" }, ctx);
    expect(out).toContain("hello");
  });

  it("works from a nested cwd (the 'cd then read all' case)", async () => {
    const ctx = makeCtx(path.join(tmp, "files"));
    const out = await TOOL_HANDLERS.read_all({}, ctx);
    expect(out).toContain("one.txt");
    expect(out).toContain("two.txt");
    expect(out).toContain("deep/three.py");
    expect(out).not.toContain("README.md"); // parent file not included
  });

  it("tracks read paths for edit-guard", async () => {
    const ctx = makeCtx(tmp);
    await TOOL_HANDLERS.read_all({}, ctx);
    expect(ctx.readPaths?.has(path.join(tmp, "README.md"))).toBe(true);
    expect(ctx.readPaths?.has(path.join(tmp, "files", "one.txt"))).toBe(true);
  });
});
