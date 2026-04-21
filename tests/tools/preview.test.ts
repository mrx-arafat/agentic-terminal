import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { previewFileChange } from "../../src/preview.js";
import { diffStat, renderDiff } from "../../src/ui.js";

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "at-preview-"));
}

describe("previewFileChange", () => {
  it("computes diff for edit_file", async () => {
    const tmp = mkTmp();
    fs.writeFileSync(path.join(tmp, "x.txt"), "foo\nbar\nbaz");
    const p = await previewFileChange(
      "edit_file",
      { path: "x.txt", old_string: "bar", new_string: "BAR" },
      tmp,
    );
    expect(p).not.toBeNull();
    expect(p?.path).toBe("x.txt");
    expect(p?.isNew).toBe(false);
    expect(p?.diff).toContain("bar");
    expect(p?.diff).toContain("BAR");
  });

  it("marks new files", async () => {
    const tmp = mkTmp();
    const p = await previewFileChange(
      "write_file",
      { path: "new.txt", content: "hello" },
      tmp,
    );
    expect(p?.isNew).toBe(true);
    expect(p?.diff).toContain("hello");
  });

  it("handles multi_edit with multiple hunks", async () => {
    const tmp = mkTmp();
    fs.writeFileSync(path.join(tmp, "m.txt"), "one\ntwo\nthree");
    const p = await previewFileChange(
      "multi_edit",
      {
        path: "m.txt",
        edits: [
          { old_string: "one", new_string: "ONE" },
          { old_string: "three", new_string: "THREE" },
        ],
      },
      tmp,
    );
    expect(p).not.toBeNull();
    expect(p?.diff).toContain("ONE");
    expect(p?.diff).toContain("THREE");
  });

  it("returns null for unsupported tools", async () => {
    const tmp = mkTmp();
    const p = await previewFileChange("read_file", { path: "x" }, tmp);
    expect(p).toBeNull();
  });
});

describe("renderDiff + diffStat", () => {
  it("reports no change for identical content", () => {
    expect(renderDiff("a\nb\n", "a\nb\n")).toMatch(/no change/);
    expect(diffStat("x", "x")).toBe("no change");
  });

  it("counts added and removed lines", () => {
    const stat = diffStat("a\nb\nc", "a\nbb\nc");
    expect(stat).toMatch(/\+1/);
    expect(stat).toMatch(/-1/);
  });

  it("renders unified diff with +/- markers", () => {
    const out = renderDiff("a\nb\nc", "a\nbb\nc");
    expect(out).toMatch(/-b/);
    expect(out).toMatch(/\+bb/);
  });
});
