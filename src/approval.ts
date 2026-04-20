import * as readline from "node:readline";
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

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a)));
}

export async function requestApproval(opts: {
  toolName: string;
  argsPreview: string;
  level: Sensitivity;
  reason?: string;
  rl: readline.Interface;
}): Promise<ApprovalResult> {
  const { toolName, argsPreview, level, rl } = opts;

  let color = chalk.white;
  if (level === "safe") color = chalk.green;
  else if (level === "dangerous") color = chalk.yellow;
  else if (level === "destructive") color = chalk.red;

  const reasonMsg = opts.reason ? ` (${opts.reason})` : "";
  console.log(color(`[${level.toUpperCase()}] ${toolName}(${argsPreview})${reasonMsg}`));

  const prompt = `  [y]es [n]o [a]lways [s]uggest > `;
  const raw = (await ask(rl, prompt)).trim().toLowerCase();
  const char = raw[0] ?? "n";

  if (char === "y") return { action: "approve" };
  if (char === "a") return { action: "approve_always" };
  if (char === "s") {
    const suggestion = (await ask(rl, "  alternative > ")).trim();
    return { action: "suggest", suggestion };
  }
  return { action: "reject" };
}
