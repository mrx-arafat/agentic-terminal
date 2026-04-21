import { describe, it, expect } from "vitest";
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

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "at-edit-"));
}

describe("edit_file fallback to write", () => {
  it("treats edit_file on an empty existing file with no old_string as a write", async () => {
    const tmp = mkTmp();
    const p = path.join(tmp, "index.html");
    fs.writeFileSync(p, "");
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.edit_file(
      { path: "index.html", old_string: "", new_string: "<h1>hi</h1>" },
      ctx,
    );
    expect(out).toMatch(/ok: wrote/);
    expect(fs.readFileSync(p, "utf8")).toBe("<h1>hi</h1>");
  });

  it("treats edit_file on a missing file with new_string as a write", async () => {
    const tmp = mkTmp();
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.edit_file(
      { path: "new.txt", old_string: "", new_string: "hello" },
      ctx,
    );
    expect(out).toMatch(/ok: wrote/);
    expect(fs.readFileSync(path.join(tmp, "new.txt"), "utf8")).toBe("hello");
  });

  it("returns a helpful error (not cryptic) when edit is mis-used on non-empty file without old_string", async () => {
    const tmp = mkTmp();
    const p = path.join(tmp, "a.txt");
    fs.writeFileSync(p, "existing content\n");
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.edit_file(
      { path: "a.txt", old_string: "", new_string: "whatever" },
      ctx,
    );
    expect(out).toMatch(/use write_file/);
  });
});

describe("multi_edit fallback to write", () => {
  it("concatenates new_strings when all old_strings are empty and file is empty", async () => {
    const tmp = mkTmp();
    const p = path.join(tmp, "combined.txt");
    fs.writeFileSync(p, "");
    const ctx = makeCtx(tmp);
    const out = await TOOL_HANDLERS.multi_edit(
      {
        path: "combined.txt",
        edits: [
          { old_string: "", new_string: "line 1\n" },
          { old_string: "", new_string: "line 2\n" },
        ],
      },
      ctx,
    );
    expect(out).toMatch(/ok: wrote/);
    expect(fs.readFileSync(p, "utf8")).toBe("line 1\nline 2\n");
  });
});
