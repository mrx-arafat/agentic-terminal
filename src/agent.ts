import type readline from "node:readline";
import ora from "ora";
import chalk from "chalk";
import type { Config } from "./config.js";
import type { Provider } from "./providers/types.js";
import type { Message, ToolCall } from "./providers/types.js";
import { TOOL_DEFS, TOOL_HANDLERS, findTool, type ToolContext } from "./tools.js";
import { confirm, errorLine, renderMarkdown, toolLine, toolResult, warnLine } from "./ui.js";

export interface AgentDeps {
  cfg: Config;
  provider: Provider;
  ctx: ToolContext;
  rl: readline.Interface;
  history: Message[];
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
  const { cfg, provider, ctx, rl, history } = deps;

  history.push({ role: "user", content: userInput });

  const systemMsg: Message = { role: "system", content: buildSystemPrompt(ctx) };

  for (let i = 0; i < cfg.maxIterations; i++) {
    const spinner = ora({ text: chalk.gray(`${provider.name} thinking…`), spinner: "dots" }).start();
    let response;
    try {
      response = await provider.chat([systemMsg, ...history], TOOL_DEFS);
      spinner.stop();
    } catch (e) {
      spinner.stop();
      console.log(errorLine((e as Error).message));
      return;
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
      return;
    }

    for (const call of response.toolCalls) {
      const result = await executeTool(call, ctx, rl, cfg);
      history.push({
        role: "tool",
        toolCallId: call.id,
        name: call.name,
        result,
      });
    }
  }

  console.log(warnLine(`reached max iterations (${cfg.maxIterations}); stopping`));
}

async function executeTool(
  call: ToolCall,
  ctx: ToolContext,
  rl: readline.Interface,
  cfg: Config,
): Promise<string> {
  const def = findTool(call.name);
  const handler = TOOL_HANDLERS[call.name];

  console.log(toolLine(call.name, call.args));

  if (!def || !handler) {
    const msg = `unknown tool: ${call.name}`;
    console.log(errorLine(msg));
    return msg;
  }

  if (def.dangerous && !cfg.autoApprove) {
    const ok = await confirm(rl, `run this ${call.name}?`, true);
    if (!ok) {
      const denied = "denied by user";
      console.log(errorLine(denied));
      return denied;
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
