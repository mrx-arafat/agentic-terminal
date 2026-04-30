import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { highlight, supportsLanguage } from "cli-highlight";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const LANG_ALIASES: Record<string, string> = {
  sh: "bash", shell: "bash", zsh: "bash", console: "bash",
  js: "javascript", ts: "typescript", jsx: "javascript", tsx: "typescript",
  py: "python", rb: "ruby", yml: "yaml", md: "markdown",
};

function highlightCode(code: string, lang: string | undefined): string {
  if (!lang) return code;
  const normalized = LANG_ALIASES[lang.toLowerCase()] ?? lang.toLowerCase();
  if (!supportsLanguage(normalized)) return code;
  try {
    return highlight(code, { language: normalized, ignoreIllegals: true });
  } catch {
    return code;
  }
}

marked.use(
  markedTerminal({
    firstHeading: chalk.bold.cyan.underline,
    heading: chalk.bold.cyan,
    strong: chalk.bold,
    em: chalk.italic,
    codespan: chalk.magenta,
    // Block code handled by our own pre-pass below (marked-terminal only accepts a chalk instance here).
    code: chalk.white,
    blockquote: chalk.gray.italic,
    link: chalk.blue.underline,
    href: chalk.blue.underline,
    hr: chalk.gray,
    table: chalk.reset,
    width: Math.max(80, (process.stdout.columns ?? 100) - 4),
    reflowText: false,
    tab: 2,
  }) as never,
);

export function styleCodeBlock(code: string, lang: string | undefined): string {
  const langLabel = lang ? chalk.gray(" " + lang) : "";
  const trimmed = code.replace(/\s*\n\s*$/g, "").replace(/[ \t]+$/g, "");
  const highlighted = highlightCode(trimmed, lang);
  return `${chalk.gray("┌─") + langLabel}\n${highlighted}\n${chalk.gray("└─")}`;
}

/** Render a block of AI-generated markdown to a styled terminal string. */
export function renderMarkdown(text: string): string {
  if (!text.trim()) return "";

  // Swap fenced code blocks with placeholders so we can apply syntax highlight
  // and a boxed presentation that marked-terminal can't do natively.
  const blocks: { lang: string; code: string }[] = [];
  const prepared = text.replace(/```(\w+)?\n?([\s\S]*?)```/g, (_, lang: string | undefined, code: string) => {
    const i = blocks.length;
    blocks.push({ lang: (lang ?? "").trim(), code: code.replace(/\n$/, "") });
    return `\n§§CODE_BLOCK_${i}§§\n`;
  });

  let body: string;
  try {
    body = String(marked.parse(prepared)).trimEnd();
  } catch {
    body = text;
  }

  // Splice code blocks in WITHOUT the agent gutter so triple-click selection
  // captures only command text — gutters break paste-into-terminal.
  const gutter = chalk.gray("│ ");
  const ansiRe = /\x1b\[[0-9;]*m/g;
  const isVisuallyBlank = (s: string): boolean => s.replace(ansiRe, "").length === 0;
  const segments = body.split(/(§§CODE_BLOCK_\d+§§)/);
  const rendered: string[] = [];
  for (const seg of segments) {
    const m = seg.match(/^§§CODE_BLOCK_(\d+)§§$/);
    if (m) {
      const b = blocks[Number(m[1])];
      if (b) rendered.push(styleCodeBlock(b.code, b.lang));
      continue;
    }
    if (isVisuallyBlank(seg)) continue;
    const guttered = seg
      .split("\n")
      .map((l) => (isVisuallyBlank(l) ? "" : gutter + l))
      .join("\n");
    rendered.push(guttered);
  }

  let joined = rendered.join("\n").replace(/\n{3,}/g, "\n\n");
  joined = joined.replace(/^\n+/, "").replace(/\n+$/, "");

  return `${chalk.gray("╭─ agent")}\n${joined}\n${chalk.gray("╰─")}`;
}

export function banner(providerName: string, model: string, cwd: string): string {
  const title = chalk.bold.cyan("Agentic Terminal");
  const sub = chalk.gray(`${providerName}  ·  ${model}`);
  const where = chalk.gray(cwd);
  return `\n${title}\n${sub}\n${where}\n${chalk.gray("type /help for commands · Ctrl+C to cancel · Ctrl+D to exit")}\n`;
}

function shortCwd(cwd: string): string {
  const home = process.env.HOME ?? os.homedir();
  const withTilde = cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const parts = withTilde.split(path.sep);
  if (parts.length <= 4) return withTilde;
  return [parts[0], "…", ...parts.slice(-2)].join(path.sep);
}

export function gitBranch(cwd: string): string | undefined {
  let dir = cwd;
  for (let i = 0; i < 30; i++) {
    const head = path.join(dir, ".git", "HEAD");
    try {
      if (fs.existsSync(head)) {
        const content = fs.readFileSync(head, "utf8").trim();
        const m = content.match(/^ref:\s+refs\/heads\/(.+)$/);
        if (m) return m[1];
        return content.slice(0, 7); // detached HEAD
      }
    } catch { /* keep walking */ }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

export function promptPrefix(cwd: string): string {
  const short = shortCwd(cwd);
  const branch = gitBranch(cwd);
  const gitPart = branch ? ` ${chalk.yellow("git:(" + branch + ")")}` : "";
  return `\n${chalk.green("➜")} ${chalk.bold.blue(short)}${gitPart} ${chalk.cyan("›")} `;
}

export function errorLine(msg: string): string {
  return chalk.red("✗ " + msg);
}

export function infoLine(msg: string): string {
  return chalk.gray(msg);
}

export function warnLine(msg: string): string {
  return chalk.yellow("! " + msg);
}

export function successLine(msg: string): string {
  return chalk.green("✓ " + msg);
}

export function question(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a)));
}

export async function confirm(rl: readline.Interface, msg: string, defaultYes = false): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const ans = (await question(rl, `${chalk.yellow("?")} ${msg} ${chalk.gray(hint)} `)).trim().toLowerCase();
  if (ans === "") return defaultYes;
  return ans === "y" || ans === "yes";
}

/** Minimal unified-diff renderer. Line-based w/ common prefix/suffix folding. */
export function renderDiff(oldStr: string, newStr: string, pathHint?: string, contextLines = 3): string {
  if (oldStr === newStr) return chalk.gray("(no change)");
  const A = oldStr.split("\n");
  const B = newStr.split("\n");
  const maxCommon = Math.min(A.length, B.length);
  let prefix = 0;
  while (prefix < maxCommon && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < maxCommon - prefix &&
    A[A.length - 1 - suffix] === B[B.length - 1 - suffix]
  ) suffix++;

  const removed = A.slice(prefix, A.length - suffix);
  const added = B.slice(prefix, B.length - suffix);
  const ctxBefore = A.slice(Math.max(0, prefix - contextLines), prefix);
  const ctxAfter = A.slice(A.length - suffix, Math.min(A.length, A.length - suffix + contextLines));

  const lines: string[] = [];
  if (pathHint) {
    lines.push(chalk.bold.gray(`--- ${pathHint}`));
    lines.push(chalk.bold.gray(`+++ ${pathHint}`));
  }
  const hunkStart = Math.max(1, prefix - ctxBefore.length + 1);
  lines.push(chalk.cyan(`@@ -${hunkStart},${ctxBefore.length + removed.length + ctxAfter.length} +${hunkStart},${ctxBefore.length + added.length + ctxAfter.length} @@`));
  for (const l of ctxBefore) lines.push(chalk.gray(` ${l}`));
  for (const l of removed) lines.push(chalk.red(`-${l}`));
  for (const l of added) lines.push(chalk.green(`+${l}`));
  for (const l of ctxAfter) lines.push(chalk.gray(` ${l}`));
  return lines.join("\n");
}

/** Summary like "+12 -3". */
export function diffStat(oldStr: string, newStr: string): string {
  if (oldStr === newStr) return "no change";
  const A = oldStr.split("\n");
  const B = newStr.split("\n");
  const maxCommon = Math.min(A.length, B.length);
  let prefix = 0;
  while (prefix < maxCommon && A[prefix] === B[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < maxCommon - prefix &&
    A[A.length - 1 - suffix] === B[B.length - 1 - suffix]
  ) suffix++;
  const removed = A.length - prefix - suffix;
  const added = B.length - prefix - suffix;
  return `${chalk.green(`+${added}`)} ${chalk.red(`-${removed}`)}`;
}

export function suggestForError(msg: string): string | undefined {
  const lower = msg.toLowerCase();
  if (lower.includes("401") || lower.includes("auth") || lower.includes("invalid key")) {
    return "check your API key: run 'agentic setup'";
  }
  if (lower.includes("429") || lower.includes("rate limit")) {
    return "rate limited — wait a minute or switch providers: /provider <name>";
  }
  if (lower.includes("econnrefused") || lower.includes("fetch failed") || lower.includes("network")) {
    return "network error — check your connection or (for Ollama) whether ollama serve is running";
  }
  if (lower.includes("command not found") || lower.includes("enoent")) {
    return "binary missing — install it or check PATH";
  }
  if (lower.includes("permission denied") || lower.includes("eacces")) {
    return "permission denied — try again with sudo (Agentic will prompt) or fix file permissions";
  }
  return undefined;
}
