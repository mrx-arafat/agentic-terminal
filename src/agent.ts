import chalk from "chalk";
import type { Config } from "./config.js";
import type { Provider } from "./providers/types.js";
import type { Message, ToolCall } from "./providers/types.js";
import { TOOL_DEFS, TOOL_HANDLERS, findTool, type ToolContext } from "./tools.js";
import { errorLine, renderMarkdown, warnLine, suggestForError, infoLine } from "./ui.js";
import { type SessionState, recordTurn, type CommandSuggestion } from "./session.js";
import { classify } from "./sensitivity.js";
import { requestApproval, CancelError } from "./approval.js";
import type { Skill } from "./skills/types.js";
import { rankSkills } from "./skills/trigger.js";
import { buildSkillSystemPrompt } from "./skills/executor.js";
import type { MCPManager } from "./mcp/manager.js";
import { previewFileChange } from "./preview.js";
import { startToolCard } from "./tool-card.js";
import type { SessionContext } from "./context.js";

export interface AgentDeps {
  cfg: Config;
  provider: Provider;
  ctx: ToolContext;
  history: Message[];
  session: SessionState;
  abortSignal: AbortSignal;
  skills?: Skill[];
  mcp?: MCPManager;
  sessionContext?: SessionContext;
}

const RUNNABLE_LANGS = new Set(["bash", "shell", "sh", "zsh", "console"]);
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const FENCE_RE = /```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g;
const MAX_SUGGESTIONS = 10;

/** Heuristic: does an untagged fenced block look like shell commands? */
function looksLikeShell(code: string): boolean {
  const lines = code.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
  if (lines.length === 0) return false;
  for (const line of lines) {
    // Reject lines with obvious non-shell syntax markers.
    if (/[<>]/.test(line) && /<\/?[a-zA-Z][^>]*>/.test(line)) return false; // HTML/XML tag
    if (/;\s*$/.test(line)) return false;                                    // JS/TS statement
    if (/^(const|let|var|function|class|import|export|interface|type)\b/.test(line)) return false;
    if (/^def\s+\w+\s*\(.*\)\s*:/.test(line)) return false;                  // Python def
    if (/^class\s+\w+.*:/.test(line)) return false;                          // Python class
    if (/=>\s*[{(]/.test(line)) return false;                                // arrow function
    if (/^\s*(if|for|while|elif|else)\b.*:\s*$/.test(line)) return false;    // python control flow
  }
  return true;
}

/** Extract fenced code blocks the user might want to run/insert/copy. */
export function extractRunnableBlocks(text: string): CommandSuggestion[] {
  if (!text) return [];
  const stripped = text.replace(ANSI_ESCAPE_RE, "");
  const out: CommandSuggestion[] = [];
  let nextId = 1;
  FENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = FENCE_RE.exec(stripped)) !== null) {
    if (out.length >= MAX_SUGGESTIONS) break;
    const rawTag = (match[1] ?? "").toLowerCase();
    const code = (match[2] ?? "").trimEnd();
    if (code.length === 0 || code.trim().length === 0) continue;
    let lang: string;
    if (rawTag === "") {
      if (!looksLikeShell(code)) continue;
      lang = "";
    } else if (RUNNABLE_LANGS.has(rawTag)) {
      lang = "bash";
    } else {
      continue;
    }
    out.push({ id: nextId++, lang, code });
  }
  return out;
}

function printSuggestionHint(suggestions: CommandSuggestion[]): void {
  if (suggestions.length === 0) return;
  const idList = suggestions.length === 1 ? "1" : `1-${suggestions.length}`;
  console.log(chalk.dim(`↳  /run ${idList} · /insert ${idList} · /copy ${idList}`));
}

/** If the previous turn had cancelled tool results, surface a resume hint
 *  so weaker models understand they should continue the interrupted work. */
function buildResumeHint(history: Message[], userInput: string): string {
  // Find the most recent assistant↔tool exchange and check whether any tool
  // result is a cancellation. If so, the previous turn was interrupted.
  let hasCancelled = false;
  let lastPlan: string | null = null;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role === "tool" && /cancelled by user/i.test(m.result)) {
      hasCancelled = true;
    }
    if (m.role === "assistant" && (m.toolCalls?.length ?? 0) > 0) {
      lastPlan = m.content?.slice(0, 400) || null;
      break;
    }
  }
  if (!hasCancelled) return "";
  const userAsksResume = /^(continue|go on|keep going|resume|proceed|finish|carry on|ok|go|yes)$/i.test(userInput.trim());
  const hint = [
    "\n\n## Resume from interruption",
    "The previous turn was interrupted mid-work. Cancelled tool results are already in the history.",
    lastPlan ? `Your last stated intent: ${lastPlan}` : "",
    userAsksResume
      ? "The user is telling you to CONTINUE. Pick up exactly where you left off — re-run the cancelled step, then continue the original plan."
      : "If the user's new message is unrelated, handle it. If it's a nudge to continue or a clarification of the original task, pick up exactly where you left off.",
  ].filter(Boolean).join("\n");
  return hint;
}

/** Render the last few shell blocks so the AI knows what the user just did. */
export function buildTerminalContext(ctx: ToolContext, limit = 3): string {
  const blocks = ctx.blocks ?? [];
  if (blocks.length === 0) return "";
  const recent = blocks.slice(-limit);
  const lines = ["\n\n## Recent terminal activity", "(commands the user ran in the shell, most recent last)"];
  for (const b of recent) {
    const short = b.command.length > 200 ? b.command.slice(0, 197) + "..." : b.command;
    const out = (b.output || "").trim();
    const outShort = out.length > 800 ? out.slice(0, 797) + "..." : out;
    const exit = b.exitCode === null ? "?" : b.exitCode;
    lines.push(`$ ${short}   (exit ${exit}, cwd ${b.cwd})`);
    if (outShort) lines.push(outShort);
  }
  return lines.join("\n");
}

export function buildSystemPrompt(ctx: ToolContext, sc?: SessionContext): string {
  const base = [
    "You are Agentic Terminal, a folder-scoped AI coding and DevOps assistant running inside the user's terminal.",
    `Current working directory: ${ctx.cwd}`,
    "You can use tools to explore files, run shell commands, read/write/edit code, search, and navigate.",
    "",
    "## Autonomy & intent inference",
    "- Act like a senior engineer who has root on this machine. The user states an outcome; you decide the steps.",
    "- NEVER ask \"which files?\" / \"should I proceed?\" / \"would you like me to...?\" when the request is unambiguous. Just do it, then report. The cost of doing and summarizing is far lower than the cost of one extra round-trip.",
    "- Ignore stale tool results from earlier cwds. When the user's cwd (shown above) changes between turns, previous list_dir/read_file results no longer describe the current location. Re-probe the current cwd before acting.",
    "",
    "## Wrap-up (mandatory when you finish a deliverable)",
    "- Never ask 'would you like me to...?' at the end. Offer the 1-3 most useful next actions as concrete, copy-pasteable commands tailored to the stack you just produced.",
    "- Match next-step hints to the stack. Do NOT suggest Python's http.server for a Node/Vite app; do NOT suggest `npm run dev` for a plain HTML file. Use this cheat-sheet:",
    "  * plain HTML/CSS → `open index.html` (macOS) or `xdg-open index.html` (Linux) or `npx --yes serve .` for a local server.",
    "  * Vite / Next / Nuxt → `npm run dev` (port shown in output).",
    "  * Python script → `python3 <script>.py`.",
    "  * Python Flask/FastAPI → the framework's run command (`flask run`, `uvicorn main:app --reload`).",
    "  * Django → `python manage.py runserver`.",
    "  * Rails → `bin/rails server`.",
    "  * Node CLI → `node <entry>.js` or `npm start`.",
    "  * Go → `go run .`.",
    "- Keep the wrap-up to ≤3 short lines. Paths should be relative to current cwd.",
    "",
    "## Request → action shortcuts",
    "- \"read all files\" / \"show me the code\" / \"what's in this folder\" / \"walk me through the repo\" → call `read_all` with path=current-cwd (or the folder named by the user). Do NOT list_dir-then-read_file-each: that's slow and error-prone. One `read_all` call.",
    "- \"find X\" in a codebase → `grep` with the right pattern. Then `read_file` hot spots if needed.",
    "- \"run the tests\" → `bash npm test` / `pytest` / `go test` depending on what the project uses.",
    "- \"explain this project\" → `read_all` at cwd (max_files=30), then summarize.",
    "",
    "- Do NOT ask the user for details that have obvious sensible defaults. Infer and proceed:",
    "  * Folder name: kebab-case slug of the request (e.g. 'simple React app' → `simple-react-app`). If the folder already exists, pick `<slug>-<n>` or ask only if ambiguous.",
    "  * Stack choices: if the user says 'React app', use Vite + React JS template. 'React TS app' → `--template react-ts`. 'Next app' → `create-next-app` with TS + App Router + ESLint defaults.",
    "  * Package manager: npm unless the repo already has `bun.lockb`/`pnpm-lock.yaml`/`yarn.lock`.",
    "  * Node/tool versions: use whatever is on PATH; don't install global toolchains unless asked.",
    "- Only ask questions when a choice is genuinely ambiguous AND has a high blast radius (e.g. overwriting existing work, deleting data, picking between wildly different architectures).",
    "- For any non-trivial request, start by calling `todo_write` with a concrete step-by-step plan, then execute the plan, updating statuses as you go.",
    "- When the user can immediately benefit from running a command you'd otherwise just describe (verifying a built site, starting a dev server, smoke-testing an endpoint), use the `bash` tool yourself. Do NOT write \"open your terminal and run X\" — execute it. For long-running servers use `bash background=true` then report the URL/port.",
    "- After executing, end the turn with a concise summary: what was created, where it lives, and how to run it.",
    "",
    "## Tool usage rules",
    "- read_file returns line-numbered content (1-based). Use line numbers when discussing locations.",
    "- You MUST read_file a file before editing it with edit_file or multi_edit. Writing a brand-new file does not require a read.",
    "- Pure reads (read_file, list_dir, grep, glob, bg_list, bg_logs) run concurrently when batched. Stateful calls (bash, cd, write_file, edit_file, create_dir, delete_*, bg_stop) are executed strictly in the order you emit them — never batch a bash that depends on a previous cd/bash in the same round; wait for the prior result first.",
    "- Use todo_write to break non-trivial tasks into steps and mark them in_progress / done as you work.",
    "- Prefer running tools to gather real information over guessing. Chain tool calls until done, then reply.",
    "- Keep final answers concise; surface exact file paths, line numbers, commands, and outputs when useful.",
    "- Never run destructive commands (rm -rf, drop, force-push, etc.) without clear user intent.",
    "",
    "## Scaffolding / dev-server patterns",
    "- Prefer non-interactive scaffolds: `npm create vite@latest <name> -- --template react` (note the `--`), `npx create-next-app@latest <name> --ts --eslint --app --no-src-dir --no-tailwind --use-npm --yes`, `npx --yes degit ...`.",
    "- `npm install` and production builds can exceed the default 120s timeout — pass `timeout: 600000` on bash.",
    "- Standard app-creation flow: scaffold → cd into project → install deps → run production build → list_dir dist/build to confirm artifacts → report URL to run dev server.",
    "- To run dev servers / watchers, call bash with `background: true`. Don't block the conversation on a foreground `npm run dev`.",
    "- Verify a running server via `curl -sI http://localhost:<port>` after a short wait; use bg_logs to inspect output and bg_stop to terminate when done.",
  ].join("\n");
  return sc ? `${base}\n\n${sc.summary}` : base;
}

export async function runTurn(deps: AgentDeps, userInput: string): Promise<void> {
  const { cfg, provider, ctx, history, session, abortSignal, skills, mcp, sessionContext } = deps;

  history.push({ role: "user", content: userInput });
  session.suggestions = [];
  const toolCallsForTurn: { name: string; argsPreview: string }[] = [];

  const matched = skills && skills.length > 0 ? rankSkills(userInput, skills)[0] : undefined;
  const base = buildSystemPrompt(ctx, sessionContext);
  const todoSection = ctx.todos && ctx.todos.length > 0
    ? `\n\n## Current plan\n${ctx.todos.map((t) => {
        const m = t.status === "done" ? "[x]" : t.status === "in_progress" ? "[~]" : "[ ]";
        return `${m} ${t.content}`;
      }).join("\n")}`
    : "";
  const terminalSection = buildTerminalContext(ctx);
  const resumeSection = buildResumeHint(history, userInput);
  const systemContent = matched
    ? `${base}${todoSection}${terminalSection}${resumeSection}\n\n${buildSkillSystemPrompt(matched)}`
    : `${base}${todoSection}${terminalSection}${resumeSection}`;
  const systemMsg: Message = { role: "system", content: systemContent };

  const allTools = mcp ? [...TOOL_DEFS, ...mcp.getToolDefs()] : TOOL_DEFS;

  for (let i = 0; i < cfg.maxIterations; i++) {
    const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
    const startedAt = Date.now();
    let tick = 0;
    let spinnerTimer: NodeJS.Timeout | null = null;
    const isTTY = process.stdout.isTTY;
    const paint = (): void => {
      if (!isTTY) return;
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
      const frame = spinnerFrames[tick++ % spinnerFrames.length];
      process.stdout.write(`\r\x1b[2K${chalk.cyan(frame)} ${chalk.gray(`${provider.name} thinking… ${elapsed}s`)}`);
    };
    const clearLine = (): void => {
      if (spinnerTimer) { clearInterval(spinnerTimer); spinnerTimer = null; }
      if (isTTY) process.stdout.write("\r\x1b[2K");
      else process.stdout.write("\n");
    };
    if (isTTY) {
      paint();
      spinnerTimer = setInterval(paint, 100);
    } else {
      process.stdout.write(chalk.gray(`${provider.name} thinking…`));
    }
    let response;
    try {
      response = await provider.chat([systemMsg, ...history], allTools, { signal: abortSignal });
      clearLine();
    } catch (e) {
      clearLine();
      if (abortSignal.aborted) {
        console.log(warnLine("turn interrupted — your next message will resume from here"));
        recordTurn(session, userInput, toolCallsForTurn);
        return;
      }
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

    session.suggestions = response.text ? extractRunnableBlocks(response.text) : [];
    if (session.suggestions.length > 0) {
      printSuggestionHint(session.suggestions);
    }

    history.push({
      role: "assistant",
      content: response.text,
      toolCalls: response.toolCalls,
    });

    if (response.toolCalls.length === 0) {
      if (!response.text || !response.text.trim()) {
        console.log(warnLine("model returned an empty response — /clear the history or try a stronger model"));
      }
      recordTurn(session, userInput, toolCallsForTurn);
      return;
    }

    const results = new Array<string>(response.toolCalls.length);
    const parallelIdxs: number[] = [];
    const serialIdxs: number[] = [];
    for (let k = 0; k < response.toolCalls.length; k++) {
      const c = response.toolCalls[k];
      (canRunInParallel(c, cfg, session, mcp) ? parallelIdxs : serialIdxs).push(k);
      toolCallsForTurn.push({ name: c.name, argsPreview: JSON.stringify(c.args).slice(0, 50) });
    }

    // Execute tool calls with strict guarantee: every tool call MUST get a
    // corresponding tool-role message pushed to history, even on abort/throw.
    // This keeps the assistant↔tool pairing valid so the next turn can resume
    // cleanly — the model sees its prior tool calls and their (cancelled)
    // results and picks up from there.
    let interrupted = false;
    try {
      if (parallelIdxs.length > 0) {
        // Parallel cards' spinners would fight for the cursor (each redraws via
        // \r\x1b[2K). Print one static summary, run them, then render each
        // finished card sequentially with no animation.
        if (parallelIdxs.length > 1) {
          console.log(infoLine(`◐  Running ${parallelIdxs.length} tools…`));
        }
        const skipCard = parallelIdxs.length > 1;
        await Promise.all(parallelIdxs.map(async (k) => {
          if (abortSignal.aborted) { results[k] = "cancelled by user"; return; }
          session.toolCallCount++;
          try {
            results[k] = await executeTool(response.toolCalls[k], ctx, cfg, session, mcp, skipCard);
          } catch (e) {
            results[k] = (e as Error).name === "CancelError"
              ? "cancelled by user"
              : `error: ${(e as Error).message}`;
          }
        }));
        // Render each parallel card sequentially after all work completes.
        if (skipCard) {
          for (const k of parallelIdxs) {
            const call = response.toolCalls[k];
            const result = results[k] ?? "cancelled by user";
            const isError = result === "cancelled by user" || result.startsWith("error:") || result.startsWith("rejected by user");
            const card = startToolCard(call.name, call.args);
            card.finish(isError ? "failed" : "done", result);
          }
        }
      }
      for (const k of serialIdxs) {
        if (abortSignal.aborted) {
          results[k] = "cancelled by user";
          interrupted = true;
          continue;
        }
        session.toolCallCount++;
        try {
          results[k] = await executeTool(response.toolCalls[k], ctx, cfg, session, mcp, false);
        } catch (e) {
          if ((e as Error).name === "CancelError") {
            results[k] = "cancelled by user";
            interrupted = true;
            // don't run remaining serial calls
            break;
          }
          results[k] = `error: ${(e as Error).message}`;
        }
      }
    } finally {
      for (let k = 0; k < response.toolCalls.length; k++) {
        history.push({
          role: "tool",
          toolCallId: response.toolCalls[k].id,
          name: response.toolCalls[k].name,
          result: results[k] ?? "cancelled by user",
        });
      }
    }

    if (abortSignal.aborted || interrupted) {
      console.log(warnLine("turn interrupted — your next message will resume from here"));
      recordTurn(session, userInput, toolCallsForTurn);
      return;
    }
  }

  recordTurn(session, userInput, toolCallsForTurn);
  console.log(warnLine(`reached max iterations (${cfg.maxIterations}); stopping`));
}

const PARALLEL_SAFE = new Set([
  "read_file",
  "read_all",
  "list_dir",
  "grep",
  "glob",
  "bg_list",
  "bg_logs",
]);

function canRunInParallel(
  call: ToolCall,
  _cfg: Config,
  _session: SessionState,
  mcp?: MCPManager,
): boolean {
  const isMCP = mcp?.owns(call.name) ?? false;
  if (isMCP) return false;
  // Only side-effect-free reads parallelize. Bash, cd, writes, deletes etc.
  // serialize to preserve ordering between dependent steps.
  return PARALLEL_SAFE.has(call.name);
}

async function executeTool(
  call: ToolCall,
  ctx: ToolContext,
  cfg: Config,
  session: SessionState,
  mcp?: MCPManager,
  skipCard: boolean = false,
): Promise<string> {
  const isMCP = mcp?.owns(call.name) ?? false;
  const def = isMCP ? undefined : findTool(call.name);
  const handler = isMCP ? undefined : TOOL_HANDLERS[call.name];

  if (!isMCP && (!def || !handler)) {
    const msg = `unknown tool: ${call.name}`;
    if (!skipCard) {
      const card = startToolCard(call.name, call.args);
      card.finish("failed", msg);
    }
    return msg;
  }

  const { level, reason } = classify({ tool: call.name, args: call.args });

  // Approval prompt may need a diff preview; the card body itself no longer
  // needs the preview because tool formatters express the change inline.
  const needsApproval = !(
    level === "safe" ||
    session.alwaysAllow.has(call.name) ||
    (cfg.autoApprove && level !== "destructive") ||
    session.yesUnsafe
  );

  if (needsApproval) {
    const preview = await previewFileChange(call.name, call.args, ctx.cwd).catch(() => null);
    const res = await requestApproval({
      toolName: call.name,
      argsPreview: JSON.stringify(call.args).slice(0, 50),
      level,
      reason,
      diff: preview?.diff,
    });
    if (res.action === "reject") {
      return "rejected by user";
    } else if (res.action === "suggest") {
      return `rejected by user; user suggests: ${res.suggestion}`;
    } else if (res.action === "approve_always") {
      session.alwaysAllow.add(call.name);
    }
  }

  const card = skipCard ? null : startToolCard(call.name, call.args);
  try {
    const result = isMCP
      ? await mcp!.callTool(call.name, call.args)
      : await handler!(call.args, ctx);
    const isError = result.startsWith("error:");
    card?.finish(isError ? "failed" : "done", result);
    return result;
  } catch (e) {
    if (e instanceof CancelError || (e as Error).name === "CancelError") {
      card?.finish("failed", "cancelled by user");
      throw e;
    }
    const msg = `error: ${(e as Error).message}`;
    card?.finish("failed", msg);
    return msg;
  }
}
