import { describe, it, expect, beforeEach } from "vitest";
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

function mkTmp(prefix = "at-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("read_file", () => {
  it("returns line-numbered content and tracks the read path", async () => {
    const tmp = mkTmp();
    const file = path.join(tmp, "a.txt");
    fs.writeFileSync(file, "alpha\nbeta\ngamma");
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.read_file({ path: "a.txt" }, ctx);
    expect(out).toContain("alpha");
    expect(out).toMatch(/1\s+alpha/);
    expect(out).toMatch(/3\s+gamma/);
    expect(ctx.readPaths?.has(file)).toBe(true);
  });

  it("supports offset and limit", async () => {
    const tmp = mkTmp();
    const file = path.join(tmp, "b.txt");
    fs.writeFileSync(file, "one\ntwo\nthree\nfour\nfive");
    const out = await TOOL_HANDLERS.read_file({ path: "b.txt", offset: 1, limit: 2 }, makeCtx(tmp));
    expect(out).toMatch(/2\s+two/);
    expect(out).toMatch(/3\s+three/);
    expect(out).not.toMatch(/four/);
    expect(out).toContain("more lines");
  });
});

describe("edit_file read-before-edit guard", () => {
  it("rejects edit when file has not been read", async () => {
    const tmp = mkTmp();
    const file = path.join(tmp, "c.txt");
    fs.writeFileSync(file, "hello");
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.edit_file(
      { path: "c.txt", old_string: "hello", new_string: "world" },
      ctx,
    );
    expect(out).toMatch(/must read_file/);
    expect(fs.readFileSync(file, "utf8")).toBe("hello");
  });

  it("allows edit after read", async () => {
    const tmp = mkTmp();
    const file = path.join(tmp, "d.txt");
    fs.writeFileSync(file, "hello");
    const ctx = makeCtx(tmp);
    await TOOL_HANDLERS.read_file({ path: "d.txt" }, ctx);
    const out = await TOOL_HANDLERS.edit_file(
      { path: "d.txt", old_string: "hello", new_string: "world" },
      ctx,
    );
    expect(out).toMatch(/ok: replaced/);
    expect(fs.readFileSync(file, "utf8")).toBe("world");
  });
});

describe("write_file read-before-edit guard", () => {
  it("allows writing brand-new files without a prior read", async () => {
    const tmp = mkTmp();
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.write_file(
      { path: "new.txt", content: "fresh" },
      ctx,
    );
    expect(out).toMatch(/ok: wrote/);
    expect(fs.readFileSync(path.join(tmp, "new.txt"), "utf8")).toBe("fresh");
  });

  it("rejects overwriting existing file without prior read", async () => {
    const tmp = mkTmp();
    fs.writeFileSync(path.join(tmp, "e.txt"), "orig");
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.write_file(
      { path: "e.txt", content: "new" },
      ctx,
    );
    expect(out).toMatch(/must read_file/);
    expect(fs.readFileSync(path.join(tmp, "e.txt"), "utf8")).toBe("orig");
  });
});

describe("multi_edit guard", () => {
  it("rejects multi_edit without prior read", async () => {
    const tmp = mkTmp();
    fs.writeFileSync(path.join(tmp, "m.txt"), "abc");
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.multi_edit(
      { path: "m.txt", edits: [{ old_string: "a", new_string: "z" }] },
      ctx,
    );
    expect(out).toMatch(/must read_file/);
  });
});

describe("todo_write", () => {
  it("replaces the todo list and renders a checklist", async () => {
    const ctx = makeCtx(mkTmp());
    const out = await TOOL_HANDLERS.todo_write(
      {
        todos: [
          { id: "1", content: "read config", status: "done" },
          { id: "2", content: "update schema", status: "in_progress" },
          { id: "3", content: "write tests", status: "pending" },
        ],
      },
      ctx,
    );
    expect(out).toMatch(/3 todo/);
    expect(out).toMatch(/\[x\] read config/);
    expect(out).toMatch(/\[~\] update schema/);
    expect(out).toMatch(/\[ \] write tests/);
    expect(ctx.todos).toHaveLength(3);
    expect(ctx.todos?.[1].status).toBe("in_progress");
  });

  it("errors on missing content", async () => {
    const out = await TOOL_HANDLERS.todo_write({ todos: [{ id: "x" }] }, makeCtx(mkTmp()));
    expect(out).toMatch(/missing content/);
  });
});

describe("bash block recording", () => {
  it("records each bash command as a block with exit code", async () => {
    const tmp = mkTmp();
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.bash({ command: "echo hi && exit 0" }, ctx);
    expect(out).toMatch(/exit_code: 0/);
    expect(ctx.blocks).toHaveLength(1);
    expect(ctx.blocks?.[0].command).toContain("echo hi");
    expect(ctx.blocks?.[0].exitCode).toBe(0);
    expect(ctx.blocks?.[0].output).toContain("hi");
  });

  it("records non-zero exit code", async () => {
    const tmp = mkTmp();
    const ctx = makeCtx(tmp);
    await TOOL_HANDLERS.bash({ command: "exit 3" }, ctx);
    expect(ctx.blocks?.[0].exitCode).toBe(3);
  });
});
