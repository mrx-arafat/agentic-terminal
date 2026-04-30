import { describe, expect, it } from "vitest";
import { extractRunnableBlocks } from "../src/agent.js";

describe("extractRunnableBlocks", () => {
  it("extracts a single bash block", () => {
    const text = "Run this:\n```bash\nnpm install\n```\n";
    const blocks = extractRunnableBlocks(text);
    expect(blocks).toEqual([{ id: 1, lang: "bash", code: "npm install" }]);
  });

  it("extracts multiple blocks in document order with 1-based ids", () => {
    const text = [
      "First:",
      "```bash",
      "cd foo",
      "```",
      "Then:",
      "```sh",
      "ls -la",
      "```",
      "Finally:",
      "```shell",
      "pwd",
      "```",
    ].join("\n");
    const blocks = extractRunnableBlocks(text);
    expect(blocks.map((b) => b.id)).toEqual([1, 2, 3]);
    expect(blocks.map((b) => b.code)).toEqual(["cd foo", "ls -la", "pwd"]);
  });

  it("normalizes sh/zsh/console/shell to bash", () => {
    const text = [
      "```sh\na\n```",
      "```zsh\nb\n```",
      "```console\nc\n```",
      "```shell\nd\n```",
      "```bash\ne\n```",
    ].join("\n");
    const blocks = extractRunnableBlocks(text);
    expect(blocks.length).toBe(5);
    expect(new Set(blocks.map((b) => b.lang))).toEqual(new Set(["bash"]));
  });

  it("includes untagged blocks that look shell-like", () => {
    const text = "```\ncd foo\nls -la\n```";
    const blocks = extractRunnableBlocks(text);
    expect(blocks.length).toBe(1);
    expect(blocks[0].lang).toBe("");
    expect(blocks[0].code).toBe("cd foo\nls -la");
  });

  it("excludes untagged blocks that look like JS/TS", () => {
    const text = [
      "```",
      "const x = 1;",
      "function foo() {}",
      "```",
    ].join("\n");
    expect(extractRunnableBlocks(text)).toEqual([]);
  });

  it("excludes untagged blocks that look like HTML/XML", () => {
    const text = "```\n<div class=\"x\">hi</div>\n```";
    expect(extractRunnableBlocks(text)).toEqual([]);
  });

  it("excludes untagged blocks that look like Python", () => {
    const text = "```\ndef foo():\n    return 1\n```";
    expect(extractRunnableBlocks(text)).toEqual([]);
  });

  it("excludes non-runnable language tags", () => {
    const text = [
      "```json",
      "{\"a\": 1}",
      "```",
      "```typescript",
      "const x: number = 1;",
      "```",
      "```python",
      "x = 1",
      "```",
    ].join("\n");
    expect(extractRunnableBlocks(text)).toEqual([]);
  });

  it("strips trailing whitespace from code", () => {
    const text = "```bash\nls   \n\n```";
    const blocks = extractRunnableBlocks(text);
    expect(blocks).toEqual([{ id: 1, lang: "bash", code: "ls" }]);
  });

  it("skips empty or whitespace-only blocks", () => {
    const text = "```bash\n\n```\n```bash\n   \n```\n```bash\nrun\n```";
    const blocks = extractRunnableBlocks(text);
    expect(blocks).toEqual([{ id: 1, lang: "bash", code: "run" }]);
  });

  it("caps at 10 blocks", () => {
    const parts: string[] = [];
    for (let i = 0; i < 15; i++) {
      parts.push("```bash\necho " + i + "\n```");
    }
    const blocks = extractRunnableBlocks(parts.join("\n"));
    expect(blocks.length).toBe(10);
    expect(blocks[0].code).toBe("echo 0");
    expect(blocks[9].code).toBe("echo 9");
  });

  it("returns empty array for empty input", () => {
    expect(extractRunnableBlocks("")).toEqual([]);
  });

  it("does not match inline backticks", () => {
    const text = "Run `npm install` to install deps.";
    expect(extractRunnableBlocks(text)).toEqual([]);
  });

  it("does not match indented (4-space) blocks", () => {
    const text = "Some prose\n\n    cd foo\n    npm install\n\nMore prose.";
    expect(extractRunnableBlocks(text)).toEqual([]);
  });

  it("matches a fenced block with surrounding prose", () => {
    const text = [
      "Here is the next step you should take:",
      "",
      "```bash",
      "npm run dev",
      "```",
      "",
      "Then visit http://localhost:3000.",
    ].join("\n");
    const blocks = extractRunnableBlocks(text);
    expect(blocks).toEqual([{ id: 1, lang: "bash", code: "npm run dev" }]);
  });
});
