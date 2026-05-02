import { beforeAll, describe, expect, it } from "vitest";
import chalk from "chalk";
import { renderMarkdown, styleCodeBlock } from "../src/ui.js";

beforeAll(() => {
  chalk.level = 3;
});

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, "");

function extractCodeLines(rendered: string): string[] {
  const plain = stripAnsi(rendered).split("\n");
  const out: string[] = [];
  let inside = false;
  for (const line of plain) {
    if (line.startsWith("┌─")) {
      inside = true;
      continue;
    }
    if (line.startsWith("└─")) {
      inside = false;
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

describe("styleCodeBlock", () => {
  it("does not prefix code lines with │", () => {
    const out = stripAnsi(styleCodeBlock("ls -la\necho hi", "bash"));
    const lines = out.split("\n");
    // header, body lines, footer
    expect(lines[0]).toBe("┌─ bash");
    expect(lines[1]).toBe("ls -la");
    expect(lines[2]).toBe("echo hi");
    expect(lines[3]).toBe("└─");
    for (const l of lines.slice(1, -1)) {
      expect(l.startsWith("│")).toBe(false);
    }
  });

  it("strips trailing blank lines", () => {
    const out = stripAnsi(styleCodeBlock("cd dir\n\n\n   \n", "bash"));
    const lines = out.split("\n");
    expect(lines[0]).toBe("┌─ bash");
    expect(lines[1]).toBe("cd dir");
    expect(lines[2]).toBe("└─");
    expect(lines.length).toBe(3);
  });

  it("renders header with lang label", () => {
    const out = stripAnsi(styleCodeBlock("x", "javascript"));
    expect(out.split("\n")[0]).toBe("┌─ javascript");
  });

  it("renders header without lang label when none provided", () => {
    const out = stripAnsi(styleCodeBlock("x", undefined));
    expect(out.split("\n")[0]).toBe("┌─");
  });

  it("renders header without lang label when lang is empty string", () => {
    const out = stripAnsi(styleCodeBlock("x", ""));
    expect(out.split("\n")[0]).toBe("┌─");
  });
});

describe("renderMarkdown", () => {
  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
    expect(renderMarkdown("   \n  ")).toBe("");
  });

  it("renders code block lines flush-left without │ prefix", () => {
    const md = "```bash\ncd bangladesh-flag\nnpx --yes serve .\n```";
    const out = renderMarkdown(md);
    const code = extractCodeLines(out);
    expect(code).toEqual(["cd bangladesh-flag", "npx --yes serve ."]);
  });

  it("indents prose but not code in mixed content", () => {
    const md = "To start, run:\n\n```bash\nnpm start\n```\n\nThen open the URL.";
    const out = renderMarkdown(md);
    const plain = stripAnsi(out);
    const lines = plain.split("\n").filter((l) => l.length > 0);

    // First non-empty line should start with bullet
    const firstContent = lines.find((l) => /[A-Za-z]/.test(l)) ?? "";
    expect(firstContent.startsWith("● ")).toBe(true);

    const codeLines = extractCodeLines(out);
    expect(codeLines).toContain("npm start");
    for (const l of codeLines) expect(l.startsWith("│")).toBe(false);
    for (const l of codeLines) expect(l.startsWith("●")).toBe(false);
  });

  it("renders two consecutive code blocks correctly", () => {
    const md = "```bash\nfoo\n```\n\n```bash\nbar\n```";
    const out = renderMarkdown(md);
    const plain = stripAnsi(out);
    const headerCount = plain.split("\n").filter((l) => l.startsWith("┌─")).length;
    const footerCount = plain.split("\n").filter((l) => l.startsWith("└─")).length;
    expect(headerCount).toBe(2);
    expect(footerCount).toBe(2);
    const code = extractCodeLines(out);
    expect(code).toEqual(["foo", "bar"]);
  });

  it("renders prose with bullet prefix", () => {
    const out = renderMarkdown("Hello world");
    const plain = stripAnsi(out);
    const lines = plain.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("● Hello world");
  });

  it("handles code block at the very start", () => {
    const md = "```bash\necho hi\n```\n\nafter";
    const out = renderMarkdown(md);
    const plain = stripAnsi(out);
    expect(plain).toContain("┌─ bash");
    expect(plain).toContain("after");
  });

  it("handles code block at the very end", () => {
    const md = "before\n\n```bash\necho hi\n```";
    const out = renderMarkdown(md);
    const plain = stripAnsi(out);
    const lines = plain.split("\n").filter((l) => l.length > 0);
    expect(lines[lines.length - 1]).toBe("└─");
  });

  it("does not produce excessive blank lines", () => {
    const md = "para\n\n```bash\nx\n```\n\nend";
    const out = renderMarkdown(md);
    const plain = stripAnsi(out);
    expect(plain).not.toMatch(/\n\n\n\n/);
  });

  it("triple-click copyability: extracted code equals original input exactly", () => {
    const code = "cd bangladesh-flag\nnpx --yes serve .";
    const md = "Run:\n\n```bash\n" + code + "\n```";
    const out = renderMarkdown(md);
    const extracted = extractCodeLines(out).join("\n");
    expect(extracted).toBe(code);
  });

  it("does not contain │ characters anywhere on code body lines", () => {
    const md = "```bash\nls -la\nps aux\n```";
    const out = renderMarkdown(md);
    const code = extractCodeLines(out);
    for (const l of code) {
      expect(l).not.toContain("│");
    }
  });

  it("starts agent text with bullet prefix", () => {
    const out = renderMarkdown("hi");
    const plain = stripAnsi(out);
    const lines = plain.split("\n").filter((l) => l.length > 0);
    expect(lines[0]).toBe("● hi");
  });

  it("strips ANSI cleanly for code with no language", () => {
    const md = "```\nplain text\n```";
    const out = renderMarkdown(md);
    const code = extractCodeLines(out);
    expect(code).toEqual(["plain text"]);
  });
});
