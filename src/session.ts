import chalk from "chalk";
import { type Config, resolveModel } from "./config.js";

export interface TurnRecord {
  userInput: string;
  toolCalls: { name: string; argsPreview: string }[];
}

export interface SessionState {
  startedAt: Date;
  provider: string;
  model: string;
  cwd: string;
  toolCallCount: number;
  inputTokens: number;
  outputTokens: number;
  alwaysAllow: Set<string>;
  turns: TurnRecord[];
  cancelled: boolean;
  yesUnsafe: boolean;
}

export function createSession(cfg: Config, provider: string, cwd: string, yesUnsafe: boolean): SessionState {
  return {
    startedAt: new Date(),
    provider,
    model: resolveModel(cfg),
    cwd,
    toolCallCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    alwaysAllow: new Set(),
    turns: [],
    cancelled: false,
    yesUnsafe,
  };
}

export function recordTurn(state: SessionState, input: string, calls: { name: string; argsPreview: string }[]): void {
  state.turns.push({ userInput: input, toolCalls: calls });
}

export function formatStatus(state: SessionState): string {
  const uptime = Math.round((new Date().getTime() - state.startedAt.getTime()) / 1000);
  const m = Math.floor(uptime / 60);
  const s = uptime % 60;
  const uptimeStr = m > 0 ? `${m}m ${s}s` : `${s}s`;

  const allowList = state.alwaysAllow.size > 0 ? Array.from(state.alwaysAllow).join(", ") : "none";

  return (
    chalk.bold("Session Status\n") +
    `  Provider:    ${state.provider}\n` +
    `  Model:       ${state.model}\n` +
    `  CWD:         ${state.cwd}\n` +
    `  Uptime:      ${uptimeStr}\n` +
    `  Tool Calls:  ${state.toolCallCount}\n` +
    `  Tokens:      ↑${state.inputTokens} ↓${state.outputTokens}\n` +
    `  Always Allow:${allowList}`
  );
}

export function formatHistory(state: SessionState, limit = 10): string {
  if (state.turns.length === 0) return chalk.gray("no history yet");

  const start = Math.max(0, state.turns.length - limit);
  const recent = state.turns.slice(start);

  let out = "";
  for (let i = 0; i < recent.length; i++) {
    const t = recent[i];
    out += `${chalk.bold("User:")} ${t.userInput}\n`;
    for (const c of t.toolCalls) {
      out += `  → ${chalk.cyan(c.name)}(${c.argsPreview})\n`;
    }
  }
  return out.trimEnd();
}
