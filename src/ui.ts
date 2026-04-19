import chalk from "chalk";
import { marked } from "marked";
import { markedTerminal } from "marked-terminal";
import readline from "node:readline";

marked.use(markedTerminal() as never);

export function renderMarkdown(text: string): string {
  if (!text.trim()) return "";
  try {
    return String(marked.parse(text)).trimEnd();
  } catch {
    return text;
  }
}

export function banner(providerName: string, model: string, cwd: string): string {
  const title = chalk.bold.cyan("Agentic Terminal");
  const sub = chalk.gray(`${providerName}  ·  ${model}`);
  const where = chalk.gray(cwd);
  return `\n${title}\n${sub}\n${where}\n${chalk.gray("type /help for commands · Ctrl+C to cancel · Ctrl+D to exit")}\n`;
}

export function promptPrefix(cwd: string): string {
  const short = cwd.replace(process.env.HOME ?? "", "~");
  return `${chalk.green("➜")} ${chalk.bold.blue(short)} ${chalk.cyan("›")} `;
}

export function toolLine(name: string, args: Record<string, unknown>): string {
  const preview = previewArgs(args);
  return `${chalk.magenta("⚒")} ${chalk.bold(name)}${preview ? " " + chalk.gray(preview) : ""}`;
}

function previewArgs(args: Record<string, unknown>): string {
  const priority = ["command", "path", "pattern"];
  for (const key of priority) {
    if (key in args) {
      const v = String(args[key]);
      return v.length > 120 ? v.slice(0, 117) + "..." : v;
    }
  }
  const entries = Object.entries(args);
  if (entries.length === 0) return "";
  const s = JSON.stringify(args);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

export function toolResult(name: string, result: string, ok: boolean): string {
  const head = ok ? chalk.green("✓") : chalk.red("✗");
  const body = result.trim().split("\n").slice(0, 20).map((l) => chalk.gray("  " + l)).join("\n");
  const more = result.split("\n").length > 20 ? chalk.gray(`  … (+${result.split("\n").length - 20} lines)`) : "";
  return `${head} ${chalk.bold(name)}\n${body}${more ? "\n" + more : ""}`;
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
