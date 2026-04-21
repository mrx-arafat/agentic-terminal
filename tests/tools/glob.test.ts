import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TOOL_HANDLERS, type ToolContext } from "../../src/tools.js";

function makeCtx(cwd: string): ToolContext {
  return { cwd, readPaths: new Set(), blocks: [], todos: [] };
}

function mkTmp(prefix = "at-glob-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkFile(root: string, rel: string, content = ""): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe("glob tool", () => {
  it("finds files with ** globstar (the original bug)", async () => {
    const tmp = mkTmp();
    mkFile(tmp, "app/Console/Kernel.php", "<?php");
    mkFile(tmp, "app/Http/Kernel.php", "<?php");
    mkFile(tmp, "app/Models/User.php", "<?php");

    // Case-insensitive so lowercase pattern matches PascalCase files
    const out = await TOOL_HANDLERS.glob(
      { pattern: "app/**/kernel.php", ignore_case: true },
      makeCtx(tmp),
    );
    expect(out).toContain("Kernel.php");
    expect(out).toMatch(/app\/Console\/Kernel\.php/);
    expect(out).toMatch(/app\/Http\/Kernel\.php/);
    expect(out).not.toMatch(/User\.php/);
  });

  it("case-sensitive by default — exact case required", async () => {
    const tmp = mkTmp();
    mkFile(tmp, "app/Console/Kernel.php", "<?php");
    const out = await TOOL_HANDLERS.glob(
      { pattern: "app/**/Kernel.php" },
      makeCtx(tmp),
    );
    expect(out).toContain("Kernel.php");
  });

  it("reports 'no files match' explicitly on zero hits", async () => {
    const tmp = mkTmp();
    mkFile(tmp, "a.txt", "");
    const out = await TOOL_HANDLERS.glob(
      { pattern: "app/**/kernel.php" },
      makeCtx(tmp),
    );
    expect(out).toMatch(/no files match/);
    expect(out).toContain("app/**/kernel.php");
  });

  it("includes match count header", async () => {
    const tmp = mkTmp();
    mkFile(tmp, "x.ts", "");
    mkFile(tmp, "y.ts", "");
    mkFile(tmp, "z.js", "");
    const out = await TOOL_HANDLERS.glob({ pattern: "*.ts" }, makeCtx(tmp));
    expect(out).toMatch(/files: 2/);
  });
});

describe("grep tool", () => {
  it("returns structured file:line:match output", async () => {
    const tmp = mkTmp();
    mkFile(tmp, "a.ts", "import x from 'y';\nconst foo = 1;\n");
    mkFile(tmp, "b.ts", "const bar = 2;\n");
    const out = await TOOL_HANDLERS.grep({ pattern: "const " }, makeCtx(tmp));
    expect(out).toMatch(/matches: \d+/);
    expect(out).toMatch(/a\.ts:2:/);
    expect(out).toMatch(/b\.ts:1:/);
  });

  it("explicit 'no matches' message on zero hits", async () => {
    const tmp = mkTmp();
    mkFile(tmp, "a.ts", "hello");
    const out = await TOOL_HANDLERS.grep({ pattern: "does_not_exist_xyz" }, makeCtx(tmp));
    expect(out).toMatch(/no matches for: does_not_exist_xyz/);
  });

  it("respects the type filter (ts only)", async () => {
    const tmp = mkTmp();
    mkFile(tmp, "code.ts", "needle");
    mkFile(tmp, "doc.md", "needle");
    const out = await TOOL_HANDLERS.grep(
      { pattern: "needle", type: "ts" },
      makeCtx(tmp),
    );
    expect(out).toContain("code.ts");
    expect(out).not.toContain("doc.md");
  });

  it("supports glob include filter", async () => {
    const tmp = mkTmp();
    mkFile(tmp, "app/Console/Kernel.php", "needle");
    mkFile(tmp, "app/Http/Other.php", "needle");
    const out = await TOOL_HANDLERS.grep(
      { pattern: "needle", glob: "**/Kernel.php" },
      makeCtx(tmp),
    );
    expect(out).toContain("Kernel.php");
    expect(out).not.toContain("Other.php");
  });
});
