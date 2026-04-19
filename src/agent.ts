import type readline from "node:readline";
import ora from "ora";
import chalk from "chalk";
import type { Config } from "./config.js";
import type { Provider } from "./providers/types.js";
import type { Message, ToolCall } from "./providers/types.js";
import { TOOL_DEFS, TOOL_HANDLERS, findTool, type ToolContext } from "./tools.js";
import { errorLine, renderMarkdown, toolLine, toolResult, warnLine, suggestForError, infoLine } from "./ui.js";
import { type SessionState, recordTurn } from "./session.js";
import { classify } from "./sensitivity.js";
import { requestApproval, CancelError } from "./approval.js";

export interface AgentDeps {
  cfg: Config;
  provider: Provider;
  ctx: ToolContext;
  rl: readline.Interface;
  history: Message[];
  session: SessionState;
  abortSignal: AbortSignal;
}

export function buildSystemPrompt(ctx: ToolContext): string {
  return [
    "You are Agentic Terminal, a folder-scoped AI coding and DevOps assistant running inside the user's terminal.",
    `Current working directory: ${ctx.cwd}`,
    "You can use tools to explore files, run shell commands, read/write/edit code, search, and navigate.",
    "Prefer running tools to gather real information over guessing. When a task needs multiple steps, chain tool calls until done, then reply.",
    "Only ask the user questions when truly blocked — otherwise act autonomously like a senior DevOps engineer.",
    "Keep final answers concise; surface exact file paths, commands, and outputs when useful.",
    "Never run destructive commands (rm -rf, drop, force-push, etc.) without clear user intent.",
  ].join("\n");
}

export async function runTurn(deps: AgentDeps, userInput: string): Promise<void> {
  const { cfg, provider, ctx, rl, history, session, abortSignal } = deps;

  history.push({ role: "user", content: userInput });
  const toolCallsForTurn: { name: string; argsPreview: string }[] = [];

  const systemMsg: Message = { role: "system", content: buildSystemPrompt(ctx) };

  for (let i = 0; i < cfg.maxIterations; i++) {
    const spinner = ora({ text: chalk.gray(`${provider.name} thinking…`), spinner: "dots" }).start();
    let response;
    try {
      response = await provider.chat([systemMsg, ...history], TOOL_DEFS);
      spinner.stop();
    } catch (e) {
      spinner.stop();
      const msg = (e as Error).message;
      console.log(errorLine(msg));
      const suggestion = suggestForError(msg);
      if (suggestion) console.log(infoLine(suggestion));
      return;
    }

    if (response.usage) {
      session.inputTokens += response.usage.inputTokens;
      session.outputTokens += response.usage.outputTokens;
    }

    if (response.text) {
      console.log(renderMarkdown(response.text));
    }

    history.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    });

    if (response.toolCalls.length === 0) {
      recordTurn(session, userInput, toolCallsForTurn);
      return;
    }

    for (const call of response.toolCalls) {
      if (abortSignal.aborted) {
        console.log(warnLine("(cancelled)"));
        break;
      }
      session.toolCallCount++;
      toolCallsForTurn.push({ name: call.name, argsPreview: JSON.stringify(call.args).slice(0, 50) });
      const result = await executeTool(call, ctx, rl, cfg, session);
      history.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        result,
      });
    }
    if (abortSignal.aborted) break;
  }

  recordTurn(session, userInput, toolCallsForTurn);
  console.log(warnLine(`reached max iterations (${cfg.maxIterations}); stopping`));
}

async function executeTool(
  call: ToolCall,
  ctx: ToolContext,
  rl: readline.Interface,
  cfg: Config,
  session: SessionState,
): Promise<string> {
  const def = findTool(call.name);
  const handler = TOOL_HANDLERS[call.name];

  if (!def || !handler) {
    const msg = `unknown tool: ${call.name}`;
    console.log(errorLine(msg));
    return msg;
  }

  const { level, reason } = classify({ tool: call.name, args: call.args });

  if (level === "safe" || session.alwaysAllow.has(call.name)) {
    console.log(toolLine(call.name, call.args));
  } else if (cfg.autoApprove && level !== "destructive") {
    console.log(toolLine(call.name, call.args));
  } else if (session.yesUnsafe) {
    console.log(toolLine(call.name, call.args));
  } else {
    let res;
    try {
      res = await requestApproval({
        toolName: call.name,
        argsPreview: JSON.stringify(call.args).slice(0, 50),
        level,
        reason,
        rl
      });
    } catch (e) {
      if (e instanceof CancelError || (e as Error).name === "CancelError") {
        throw e;
      }
      throw e;
    }
    if (res.action === "reject") {
      return "rejected by user";
    } else if (res.action === "suggest") {
      return `rejected by user; user suggests: ${res.suggestion}`;
    } else if (res.action === "approve_always") {
      session.alwaysAllow.add(call.name);
    }
  }

  try {
    const result = await handler(call.args, ctx);
    const isError = result.startsWith("error:");
    console.log(toolResult(call.name, result, !isError));
    return result;
  } catch (e) {
    const msg = `error: ${(e as Error).message}`;
    console.log(errorLine(msg));
    return msg;
  }
}
