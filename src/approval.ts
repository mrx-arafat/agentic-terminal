import readline from "node:readline";
import chalk from "chalk";
import type { Sensitivity } from "./sensitivity.js";

export type ApprovalAction = "approve" | "approve_always" | "reject" | "suggest";

export interface ApprovalResult {
  action: ApprovalAction;
  suggestion?: string;
}

export class CancelError extends Error {
  constructor() {
    super("Cancelled by user");
    this.name = "CancelError";
  }
}

/** Read one keystroke from stdin in raw mode. Resolves with the lowercased
 *  letter, or "esc"/"enter"/"ctrl-c". Restores cooked mode before resolving. */
function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const tty = process.stdin as NodeJS.ReadStream;
    if (!tty.isTTY) { resolve(""); return; }
    const wasRaw = tty.isRaw === true;
    if (!wasRaw) tty.setRawMode(true);
    tty.resume();

    const onData = (chunk: Buffer): void => {
      tty.off("data", onData);
      if (!wasRaw) tty.setRawMode(false);
      const c = chunk[0];
      if (c === 0x03) resolve("ctrl-c");
      else if (c === 0x1b) resolve("esc");
      else if (c === 0x0d || c === 0x0a) resolve("enter");
      else resolve(chunk.toString("utf8").trim().toLowerCase());
    };
    tty.on("data", onData);
  });
}

function askLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (a) => { rl.close(); resolve(a); });
  });
}

export async function requestApproval(opts: {
  toolName: string;
  argsPreview: string;
  level: Sensitivity;
  reason?: string;
  diff?: string;
}): Promise<ApprovalResult> {
  const { toolName, argsPreview, level, diff } = opts;

  const tag =
    level === "safe" ? chalk.green.bold(" SAFE ") :
    level === "dangerous" ? chalk.bgYellow.black.bold(" DANGEROUS ") :
    chalk.bgRed.white.bold(" DESTRUCTIVE ");

  const reasonMsg = opts.reason ? chalk.gray(` (${opts.reason})`) : "";
  console.log(`${tag} ${chalk.bold(toolName)} ${chalk.gray(argsPreview)}${reasonMsg}`);
  if (diff) console.log(diff);

  process.stdout.write(`  ${chalk.cyan("[y]")}es ${chalk.cyan("[n]")}o ${chalk.cyan("[a]")}lways ${chalk.cyan("[s]")}uggest ${chalk.gray("›")} `);
  const key = await readKey();
  process.stdout.write("\n");

  if (key === "ctrl-c") throw new CancelError();
  if (key === "y" || key === "enter") return { action: "approve" };
  if (key === "a") return { action: "approve_always" };
  if (key === "s") {
    const suggestion = (await askLine(`  ${chalk.gray("alternative ›")} `)).trim();
    return { action: "suggest", suggestion };
  }
  return { action: "reject" };
}
