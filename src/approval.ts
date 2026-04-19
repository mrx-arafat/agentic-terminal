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

  let reasonMsg = opts.reason ? ` (${opts.reason})` : "";
  console.log(color(`[${level.toUpperCase()}] ${toolName}(${argsPreview})${reasonMsg}`));

  if (!process.stdin.isTTY) {
    // Non-TTY text fallback
    return new Promise((resolve) => {
      rl.question("approve? [y/N]: ", (ans) => {
        if (ans.toLowerCase() === "y") resolve({ action: "approve" });
        else resolve({ action: "reject" });
      });
    });
  }

  process.stdout.write("  [y]es  [n]o  [a]lways-this-tool  [s]uggest-alternative  Esc=reject: ");

  return new Promise((resolve, reject) => {
    let modeReset = false;
    const restoreMode = () => {
      if (!modeReset) {
        modeReset = true;
        try {
          if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
          }
          process.stdin.resume();
        } catch (e) {
          // ignore
        }
      }
    };

    const cleanup = () => {
      process.removeListener("exit", restoreMode);
      process.removeListener("SIGTERM", restoreMode);
    };

    process.on("exit", restoreMode);
    process.on("SIGTERM", restoreMode);

    try {
      rl.pause();
      process.stdin.pause();
      process.stdin.setRawMode(true);
      process.stdin.resume();

      const handler = (data: Buffer) => {
        const hex = data.toString("hex");
        const char = data.toString().toLowerCase();

        let action: ApprovalAction | null = null;
        let isCancel = false;

        if (char === "y") action = "approve";
        else if (char === "n") action = "reject";
        else if (char === "a") action = "approve_always";
        else if (char === "s") action = "suggest";
        else if (hex === "1b") action = "reject"; // Esc
        else if (hex === "03") isCancel = true; // Ctrl+C

        if (action || isCancel) {
          console.log(action ? `\n` : `\n`);
          restoreMode();
          cleanup();

          if (isCancel) {
            rl.resume();
            reject(new CancelError());
          } else if (action === "suggest") {
            rl.question("alternative? ", (ans) => {
              rl.resume();
              resolve({ action: "suggest", suggestion: ans });
            });
          } else {
            rl.resume();
            resolve({ action: action!, suggestion: undefined });
          }
        } else {
          // not recognized, register again
          process.stdin.once("data", handler);
        }
      };

      process.stdin.once("data", handler);
    } catch (e) {
      restoreMode();
      cleanup();
      rl.resume();
      reject(e);
    }
  });
}
