import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import {
  type Config,
  type ProviderName,
  configPath,
  loadConfig,
  resolveApiKey,
  resolveModel,
  saveConfig,
  setModel,
} from "./config.js";
import { MODEL_CATALOG } from "./models.js";
import { createProvider } from "./providers/factory.js";
import type { Message, Provider } from "./providers/types.js";
import type { ToolContext } from "./tools.js";
import { runSetup, printModelList, printProviderList } from "./setup.js";
import { runTurn } from "./agent.js";
import { banner, errorLine, gitBranch, infoLine, successLine, warnLine } from "./ui.js";
import { readInput, loadHistory, appendHistory } from "./input.js";
import { createSession, formatStatus, formatHistory, type SessionState } from "./session.js";
import { TOOL_DEFS } from "./tools.js";
import { CancelError } from "./approval.js";
import { classify as classifyInput } from "./classify.js";
import { expandTilde, suggestDir } from "./shell.js";
import { spawn } from "node:child_process";
import { loadSkills, mergeSkills } from "./skills/loader.js";
import type { Skill } from "./skills/types.js";
import { MemoryStore } from "./memory/store.js";
import { detectProjectType, getProjectName } from "./memory/detector.js";
import { MCPManager } from "./mcp/manager.js";
import { buildSessionContext, type SessionContext } from "./context.js";
import type { BgProcess, BlockRecord, TodoItem } from "./blocks.js";
import { wireEscInterrupt } from "./interrupt.js";
import { handleRun, handleInsert, handleCopy } from "./suggestions.js";

const VERSION = "0.7.0";

function usage(): void {
  console.log(`
${chalk.bold("Agentic Terminal")} ${chalk.gray("v" + VERSION)}
folder-scoped AI terminal agent (Gemini / Claude / OpenAI / Ollama)

${chalk.bold("Usage:")}
  agentic                       start interactive session in current folder
  agentic "prompt here"         one-shot: run a single prompt and exit
  agentic setup                 configure provider, API key, and model
  agentic providers             list supported providers
  agentic models [provider]     list available models (current provider if omitted)
  agentic config                print config file path and current settings
  agentic --help                show this help
  agentic --version             show version

${chalk.bold("Flags (interactive):")}
  --cwd <path>                  start in specific directory
  --provider <name>             override provider for this run (gemini|claude|openai|ollama)
  --model <id>                  override model for this run
  --yes                         auto-approve dangerous tools
  --yes-unsafe                  auto-approve ALL tools including destructive

${chalk.bold("Examples:")}
  agentic
  agentic "fix the nginx config in ./conf.d"
  atx "prompt"
  agentic --provider ollama --model qwen2.5:7b
  agentic setup
`);
}

interface ParsedArgs {
  subcommand?: string;
  prompt?: string;
  cwd?: string;
  providerOverride?: ProviderName;
  modelOverride?: string;
  yes: boolean;
  yesUnsafe: boolean;
  help: boolean;
  version: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { yes: false, yesUnsafe: false, help: false, version: false, rest: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--yes-unsafe") out.yesUnsafe = true;
    else if (a === "--yes" || a === "-y") out.yes = true;
    else if (a === "--cwd") out.cwd = argv[++i];
    else if (a === "--provider") out.providerOverride = argv[++i] as ProviderName;
    else if (a === "--model") out.modelOverride = argv[++i];
    else if (a === "--setup") out.subcommand = "setup";
    else if (a === "--providers") out.subcommand = "providers";
    else if (a === "--models") out.subcommand = "models";
    else if (a === "--config") out.subcommand = "config";
    else positional.push(a);
  }
  const subcommands = new Set(["setup", "providers", "models", "config"]);
  if (!out.subcommand && positional[0] && subcommands.has(positional[0])) {
    out.subcommand = positional[0];
    out.rest = positional.slice(1);
  } else if (!out.subcommand && positional.length > 0) {
    out.prompt = positional.join(" ");
  } else if (out.subcommand && positional.length > 0) {
    out.rest = positional;
  }
  return out;
}

function applyOverrides(cfg: Config, args: ParsedArgs): Config {
  const next = { ...cfg };
  if (args.providerOverride) next.provider = args.providerOverride;
  if (args.modelOverride) setModel(next, args.modelOverride);
  if (args.yes) next.autoApprove = true;
  return next;
}

async function loadAllSkills(cwd: string): Promise<Skill[]> {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const builtinDir = path.join(thisDir, "skills", "builtin");
  const globalDir = path.join(os.homedir(), ".config", "agentic-terminal", "skills");
  const projectDir = path.join(cwd, ".agentic", "skills");
  const [builtin, global, project] = await Promise.all([
    loadSkills(builtinDir),
    loadSkills(globalDir),
    loadSkills(projectDir),
  ]);
  // project overrides global overrides builtin
  return mergeSkills(mergeSkills(builtin, global), project);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { usage(); return; }
  if (args.version) { console.log(VERSION); return; }

  if (args.subcommand === "setup") { await runSetup(); return; }
  if (args.subcommand === "providers") { printProviderList(); return; }
  if (args.subcommand === "models") {
    const cfg = loadConfig();
    const p = (args.rest[0] as ProviderName) || cfg.provider;
    if (!(p in MODEL_CATALOG)) {
      console.log(errorLine(`unknown provider: ${p}`));
      process.exit(1);
    }
    printModelList(p);
    return;
  }
  if (args.subcommand === "config") {
    const cfg = loadConfig();
    console.log(infoLine(`path: ${configPath()}`));
    console.log(JSON.stringify({ ...cfg, geminiApiKey: mask(cfg.geminiApiKey), claudeApiKey: mask(cfg.claudeApiKey), openaiApiKey: mask(cfg.openaiApiKey) }, null, 2));
    return;
  }

  const cwd = args.cwd ? path.resolve(args.cwd) : process.cwd();
  if (!fs.existsSync(cwd)) {
    console.log(errorLine(`cwd does not exist: ${cwd}`));
    process.exit(1);
  }

  const baseCfg = loadConfig();
  const cfg = applyOverrides(baseCfg, args);

  const apiKey = resolveApiKey(cfg);
  const noKeyNeeded = cfg.provider === "ollama" || cfg.provider === "claude-cli";
  if (!noKeyNeeded && !apiKey) {
    console.log(errorLine(`no API key for ${cfg.provider}. run: agentic setup`));
    process.exit(1);
  }

  let provider;
  try {
    provider = createProvider(cfg);
  } catch (e) {
    console.log(errorLine((e as Error).message));
    process.exit(1);
  }

  const readPaths = new Set<string>();
  const blocks: BlockRecord[] = [];
  const todos: TodoItem[] = [];
  const bgProcs: BgProcess[] = [];
  const ctx: ToolContext = { cwd, readPaths, blocks, todos, bgProcs };
  const sessionContext: SessionContext = buildSessionContext(cwd);
  const history: Message[] = [];
  const session = createSession(cfg, provider.name, ctx.cwd, args.yesUnsafe);

  const skills = await loadAllSkills(cwd);

  const memStore = new MemoryStore(path.join(os.homedir(), ".agentic", "projects"));
  const projectName = getProjectName(cwd);
  const projectType = detectProjectType(cwd);
  const mem = await memStore.load(projectName) ?? await memStore.initialize(projectName, projectType, cwd);
  void mem; // available for future use

  const mcp = new MCPManager();
  await mcp.loadConfigs(cwd);
  if (mcp.listConfigured().length > 0) {
    await mcp.connectAll((msg) => console.log(warnLine(msg)));
    const ready = mcp.status().filter((s) => s.status === "ready");
    if (ready.length > 0) {
      const total = ready.reduce((n, s) => n + s.toolCount, 0);
      console.log(infoLine(`mcp: ${ready.length} server(s), ${total} tool(s) ready`));
    }
  }

  const shutdown = async (): Promise<void> => {
    await mcp.disconnectAll().catch(() => undefined);
  };
  process.once("SIGTERM", () => { void shutdown().finally(() => process.exit(0)); });

  if (args.prompt) {
    const controller = new AbortController();
    try {
      await runTurn({ cfg, provider, ctx, history, session, abortSignal: controller.signal, skills, mcp, sessionContext }, args.prompt);
    } catch (e) {
      if (e instanceof CancelError || (e as Error).name === "CancelError") {
        controller.abort();
        console.log(warnLine("(cancelled)"));
      } else {
        throw e;
      }
    } finally {
      await shutdown();
    }
    return;
  }

  console.log(banner(provider.name, resolveModel(cfg), ctx.cwd, {
    version: VERSION,
    branch: gitBranch(ctx.cwd),
  }));

  const histList = loadHistory();
  let turnInProgress = false;
  let turnAbort: AbortController | null = null;
  let resumeText = "";
  let pendingInitial = "";
  let lastInterruptAt = 0;

  const detachEsc = wireEscInterrupt(process.stdin, {
    isActive: () => turnInProgress && turnAbort !== null && !turnAbort.signal.aborted,
    onInterrupt: () => {
      if (!turnAbort || turnAbort.signal.aborted) return;
      turnAbort.abort();
      if (process.stdout.isTTY) process.stdout.write("\r\x1b[2K");
      console.log(warnLine("interrupted — your next message will resume from here"));
    },
  });

  while (true) {
    const branch = gitBranch(ctx.cwd);
    const headerInfo = `${chalk.bold.green(provider.name)} ${chalk.dim("·")} ${chalk.cyan(resolveModel(cfg))}`;
    const initial = pendingInitial !== "" ? pendingInitial : resumeText;
    const result = await readInput({
      cwd: ctx.cwd,
      branch,
      header: headerInfo,
      history: histList,
      initial,
      hintLines: [
        chalk.gray("enter") + " submit  " + chalk.gray("shift/alt+enter") + " newline  " + chalk.gray("tab") + " complete  " + chalk.gray("↑↓") + " history  " + chalk.gray("ctrl+d") + " exit",
      ],
      slashCommands: SLASH_COMMANDS,
      onSubmit: (text) => appendHistory(histList, text),
    });
    resumeText = "";
    pendingInitial = "";

    if (result.kind === "eof") break;
    if (result.kind === "interrupt") {
      const now = Date.now();
      if (now - lastInterruptAt < 1500) { console.log(infoLine("bye")); break; }
      lastInterruptAt = now;
      console.log(infoLine("(Ctrl+C) press again to exit, or type /exit"));
      continue;
    }
    const input = result.text.trim();
    if (!input) continue;

    const c = classifyInput(input);

    if (c.kind === "slash") {
      const done = await handleSlash(c.payload, {
        cfg,
        ctx,
        history,
        session,
        skills,
        mcp,
        sessionContext,
        runShell: (command) => runShell(command, ctx),
        setPendingInitial: (text) => { pendingInitial = text; },
        swapProvider: (p) => { provider = p; },
      });
      if (done === "exit") break;
      continue;
    }

    if (c.kind === "shell") {
      if (shouldShowHint(c.reason)) console.log(chalk.gray(`» shell (${c.reason})`));
      try {
        await runShell(c.payload, ctx);
      } catch (e) {
        console.log(errorLine((e as Error).message));
      }
      continue;
    }

    if (shouldShowHint(c.reason)) console.log(chalk.gray(`» ai (${c.reason})`));
    turnInProgress = true;
    turnAbort = new AbortController();
    try {
      await runTurn({ cfg, provider, ctx, history, session, abortSignal: turnAbort.signal, skills, mcp, sessionContext }, c.payload);
    } catch (e) {
      if (e instanceof CancelError || (e as Error).name === "CancelError") {
        console.log(warnLine("turn interrupted — your next message will resume from here"));
      } else {
        console.log(errorLine((e as Error).message));
      }
    } finally {
      turnInProgress = false;
      turnAbort = null;
    }
  }

  detachEsc();
  await shutdown();
}

const SLASH_COMMANDS = [
  "help", "exit", "quit", "clear", "cwd", "cd",
  "provider", "model", "models", "providers", "setup",
  "status", "history", "tools", "blocks", "block",
  "todos", "context", "skills",
  "mcp", "save", "config",
  "run", "insert", "copy",
];

/** Hide the routing hint when the classification is obvious; only surface it
 *  when the call could reasonably have gone the other way. */
const OBVIOUS_REASONS = new Set([
  "shell builtin",
  "known command",
  "env-var prefix",
  "path-like command",
  "sentence shape",
  "question mark",
  "natural-language cue",
  "prose with glue words",
]);
function shouldShowHint(reason: string | undefined): boolean {
  if (!reason) return false;
  // Reasons include a backtick suffix (e.g. "known command `ls`"); strip before compare.
  const head = reason.replace(/\s*`[^`]+`\s*$/, "").trim();
  return !OBVIOUS_REASONS.has(head);
}

async function runShell(command: string, ctx: ToolContext): Promise<void> {
  // cd needs to affect the parent's cwd — subprocess cd is useless here.
  const cdMatch = command.match(/^cd(?:\s+(.*))?$/);
  if (cdMatch) {
    const rawTarget = (cdMatch[1] ?? "").trim();
    const target = expandTilde(rawTarget);
    const dest = target ? (path.isAbsolute(target) ? target : path.resolve(ctx.cwd, target)) : os.homedir();
    if (!fs.existsSync(dest) || !fs.statSync(dest).isDirectory()) {
      console.log(errorLine(`cd: not a directory: ${dest}`));
      const needle = path.basename(rawTarget || "");
      if (needle) {
        const suggestion = suggestDir(ctx.cwd, needle);
        if (suggestion) console.log(infoLine(`did you mean: cd ${suggestion}`));
      }
      return;
    }
    ctx.cwd = dest;
    return;
  }

  const startedAt = Date.now();
  await new Promise<void>((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ctx.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let captured = "";
    const MAX_CAPTURE = 4000;
    const tee = (data: Buffer, out: NodeJS.WriteStream): void => {
      out.write(data);
      if (captured.length < MAX_CAPTURE) {
        captured += data.toString();
        if (captured.length > MAX_CAPTURE) captured = captured.slice(0, MAX_CAPTURE) + "\n[truncated]";
      }
    };
    child.stdout?.on("data", (d) => tee(d, process.stdout));
    child.stderr?.on("data", (d) => tee(d, process.stderr));
    child.on("error", (e) => { console.log(errorLine(e.message)); });
    child.on("close", (code) => {
      if (ctx.blocks) {
        ctx.blocks.push({
          id: ctx.blocks.length,
          cwd: ctx.cwd,
          command,
          startedAt,
          durationMs: Date.now() - startedAt,
          exitCode: code,
          output: captured,
          truncated: captured.endsWith("[truncated]"),
        });
      }
      if (code === 127) {
        console.log(chalk.gray(`exit 127 (command not found) — prefix with \`#\` to send to AI instead`));
      } else if (code !== 0 && code !== null) {
        console.log(chalk.gray(`exit ${code}`));
      }
      resolve();
    });
  });
}

function mask(v?: string): string | undefined {
  if (!v) return undefined;
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

interface SlashCtx {
  cfg: Config;
  ctx: ToolContext;
  history: Message[];
  session: SessionState;
  skills: Skill[];
  mcp: MCPManager;
  sessionContext: SessionContext;
  runShell: (command: string) => Promise<void>;
  setPendingInitial: (text: string) => void;
  swapProvider: (p: Provider) => void;
}

async function handleSlash(input: string, s: SlashCtx): Promise<"exit" | void> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  switch (cmd) {
    case "exit":
    case "quit":
      return "exit";
    case "skills":
      if (s.skills.length === 0) {
        console.log(infoLine("no skills loaded. add SKILL.md files to ~/.config/agentic-terminal/skills/ or .agentic/skills/"));
        return;
      }
      if (rest[0]) {
        const sk = s.skills.find((x) => x.metadata.name === rest[0]);
        if (!sk) { console.log(errorLine(`skill not found: ${rest[0]}`)); return; }
        console.log(chalk.bold(sk.metadata.name));
        console.log(chalk.gray(sk.metadata.description));
        console.log(chalk.gray("triggers: ") + sk.metadata.triggerPatterns.join(", "));
        return;
      }
      console.log(chalk.bold(`Loaded skills (${s.skills.length}):`));
      for (const sk of s.skills) {
        console.log(`  ${chalk.cyan(sk.metadata.name)}  ${chalk.gray(sk.metadata.description)}`);
      }
      return;
    case "help":
      console.log(`
${chalk.bold("Input modes (auto-detected):")}
  shell         first token is a shell builtin, known tool, or binary on PATH
  ai            everything else (sent to the LLM)
  !<cmd>        force shell
  #<prompt>     force ai
  /<cmd>        slash command

${chalk.bold("Slash commands:")}
  /help                       show this help
  /skills                     list loaded skills
  /status                     show current session status
  /history                    show conversation history and tool calls
  /tools                      list all available tools and their approval status
  /blocks                     list bash command blocks in this session
  /block <id>                 show full output of a block by id
  /todos                      show current plan (todos)
  /context                    show the auto-detected project context summary
  /mcp                        list MCP servers and status
  /mcp connect <name>         (re)connect to an MCP server
  /mcp disconnect <name>      disconnect an MCP server
  /mcp tools [server]         list MCP tools (optionally filter by server)
  /clear                      clear conversation history
  /cwd                        show current working directory
  /cd <path>                  change working directory
  /provider <name>            switch provider (gemini|claude|openai|ollama)
  /model <id>                 switch model
  /models                     list models for current provider
  /providers                  list all providers
  /config                     print config path and settings
  /save                       persist current provider/model/approve to config file
  /exit                       quit

${chalk.bold("Suggestions (from last AI reply):")}
  /run [n]                    run command suggestion #n (default 1) from last reply
  /insert [n]                 paste suggestion #n into the next prompt for editing
  /copy [n]                   copy suggestion #n to system clipboard (OSC 52)
`);
      return;
    case "clear":
      s.history.length = 0;
      console.log(successLine("history cleared"));
      return;
    case "cwd":
      console.log(infoLine(s.ctx.cwd));
      return;
    case "cd": {
      const target = rest.join(" ");
      if (!target) { console.log(errorLine("usage: /cd <path>")); return; }
      const abs = path.isAbsolute(target) ? target : path.resolve(s.ctx.cwd, target);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
        console.log(errorLine(`not a directory: ${abs}`));
        return;
      }
      s.ctx.cwd = abs;
      console.log(successLine(`cwd: ${abs}`));
      return;
    }
    case "provider": {
      const name = rest[0] as ProviderName;
      if (!name || !(name in MODEL_CATALOG)) {
        console.log(errorLine(`usage: /provider gemini|claude|openai|ollama|claude-cli`));
        return;
      }
      s.cfg.provider = name;
      s.session.provider = name;
      s.session.model = resolveModel(s.cfg);
      try {
        s.swapProvider(createProvider(s.cfg));
        console.log(successLine(`provider=${name} model=${resolveModel(s.cfg)} (use /save to persist)`));
      } catch (e) {
        console.log(errorLine(`switch failed: ${(e as Error).message}`));
      }
      return;
    }
    case "setup": {
      await runSetup();
      const fresh = loadConfig();
      Object.assign(s.cfg, fresh);
      s.session.provider = fresh.provider;
      s.session.model = resolveModel(fresh);
      try {
        s.swapProvider(createProvider(fresh));
        console.log(successLine(`provider=${fresh.provider} model=${resolveModel(fresh)}`));
      } catch (e) {
        console.log(errorLine(`provider init failed: ${(e as Error).message}`));
      }
      return;
    }
    case "model": {
      const id = rest.join(" ");
      if (!id) { console.log(errorLine("usage: /model <id>")); return; }
      setModel(s.cfg, id);
      s.session.model = id;
      try {
        s.swapProvider(createProvider(s.cfg));
        console.log(successLine(`model=${id} (use /save to persist)`));
      } catch (e) {
        console.log(errorLine(`switch failed: ${(e as Error).message}`));
      }
      return;
    }
    case "models":
      printModelList(s.cfg.provider);
      return;
    case "providers":
      printProviderList();
      return;
    case "status":
      console.log(formatStatus(s.session));
      return;
    case "history":
      console.log(formatHistory(s.session));
      return;
    case "tools": {
      console.log(chalk.bold("Native tools:"));
      for (const t of TOOL_DEFS) {
        const allowed = s.session.alwaysAllow.has(t.name) ? chalk.green("(always allow)") : "";
        console.log(`  ${chalk.cyan(t.name)} ${allowed}`);
      }
      const mcpDefs = s.mcp.getToolDefs();
      if (mcpDefs.length > 0) {
        console.log(chalk.bold("\nMCP tools:"));
        for (const t of mcpDefs) {
          const allowed = s.session.alwaysAllow.has(t.name) ? chalk.green("(always allow)") : "";
          console.log(`  ${chalk.cyan(t.name)} ${allowed}`);
        }
      }
      return;
    }
    case "blocks": {
      const blocks = s.ctx.blocks ?? [];
      if (blocks.length === 0) { console.log(infoLine("no bash blocks yet")); return; }
      for (const b of blocks) {
        const code = b.exitCode === 0 ? chalk.green(`exit ${b.exitCode}`) : chalk.red(`exit ${b.exitCode}`);
        const dur = `${b.durationMs}ms`;
        const cmd = b.command.length > 80 ? b.command.slice(0, 77) + "..." : b.command;
        console.log(`  ${chalk.cyan("#" + b.id)}  ${code}  ${chalk.gray(dur.padStart(6))}  ${cmd}`);
      }
      return;
    }
    case "block": {
      const id = Number(rest[0]);
      if (Number.isNaN(id)) { console.log(errorLine("usage: /block <id>")); return; }
      const b = (s.ctx.blocks ?? []).find((x) => x.id === id);
      if (!b) { console.log(errorLine(`no block #${id}`)); return; }
      console.log(chalk.bold(`Block #${b.id}`));
      console.log(chalk.gray(`cwd: ${b.cwd}`));
      console.log(chalk.gray(`exit: ${b.exitCode}  duration: ${b.durationMs}ms`));
      console.log(chalk.cyan(`$ ${b.command}`));
      console.log(b.output || chalk.gray("(no output)"));
      if (b.truncated) console.log(chalk.yellow("[output truncated]"));
      return;
    }
    case "todos": {
      const todos = s.ctx.todos ?? [];
      if (todos.length === 0) { console.log(infoLine("no todos")); return; }
      for (const t of todos) {
        const mark = t.status === "done" ? chalk.green("[x]") : t.status === "in_progress" ? chalk.yellow("[~]") : chalk.gray("[ ]");
        console.log(`  ${mark} ${t.content}`);
      }
      return;
    }
    case "context": {
      console.log(s.sessionContext.summary);
      return;
    }
    case "mcp": {
      const sub = rest[0];
      if (!sub || sub === "list") {
        const rows = s.mcp.status();
        if (rows.length === 0) {
          console.log(infoLine("no MCP servers configured. add ~/.config/agentic-terminal/mcp.json or .agentic/mcp.json"));
          return;
        }
        console.log(chalk.bold(`MCP servers (${rows.length}):`));
        for (const r of rows) {
          const color =
            r.status === "ready" ? chalk.green :
            r.status === "error" ? chalk.red :
            r.status === "connecting" ? chalk.yellow :
            chalk.gray;
          const tail = r.status === "error" && r.error ? chalk.gray(`  — ${r.error}`) : "";
          console.log(`  ${color(r.status.padEnd(11))} ${chalk.cyan(r.name)}  ${chalk.gray(r.toolCount + " tools")}${tail}`);
        }
        return;
      }
      if (sub === "connect") {
        const name = rest[1];
        if (!name) { console.log(errorLine("usage: /mcp connect <name>")); return; }
        try {
          await s.mcp.connect(name);
          const st = s.mcp.status().find((x) => x.name === name);
          console.log(successLine(`connected: ${name} (${st?.toolCount ?? 0} tools)`));
        } catch (e) {
          console.log(errorLine(`${name}: ${(e as Error).message}`));
        }
        return;
      }
      if (sub === "disconnect") {
        const name = rest[1];
        if (!name) { console.log(errorLine("usage: /mcp disconnect <name>")); return; }
        await s.mcp.disconnect(name);
        console.log(successLine(`disconnected: ${name}`));
        return;
      }
      if (sub === "tools") {
        const filter = rest[1];
        const defs = s.mcp.getToolDefs();
        const filtered = filter ? defs.filter((d) => d.name.startsWith(`mcp__${filter}__`)) : defs;
        if (filtered.length === 0) {
          console.log(infoLine(filter ? `no tools for '${filter}'` : "no MCP tools ready"));
          return;
        }
        for (const t of filtered) {
          console.log(`  ${chalk.cyan(t.name)}  ${chalk.gray(t.description.slice(0, 100))}`);
        }
        return;
      }
      console.log(errorLine(`unknown /mcp subcommand: ${sub}  (try: list, connect, disconnect, tools)`));
      return;
    }
    case "approve":
      console.log(warnLine("/approve is deprecated. Use --yes at launch (auto-approve safe+dangerous) or --yes-unsafe (adds destructive). During a session, press 'a' in the approval prompt to always-allow a specific tool type."));
      return;
    case "save":
      saveConfig(s.cfg);
      console.log(successLine(`saved to ${configPath()}`));
      return;
    case "config":
      console.log(infoLine(`path: ${configPath()}`));
      console.log(JSON.stringify({ ...s.cfg, geminiApiKey: mask(s.cfg.geminiApiKey), claudeApiKey: mask(s.cfg.claudeApiKey), openaiApiKey: mask(s.cfg.openaiApiKey) }, null, 2));
      return;
    case "run":
      await handleRun(s.session, rest[0], {
        runShell: s.runShell,
        log: (line) => console.log(line),
      });
      return;
    case "insert":
      handleInsert(s.session, rest[0], {
        setPendingInitial: s.setPendingInitial,
        log: (line) => console.log(line),
      });
      return;
    case "copy":
      handleCopy(s.session, rest[0], {
        log: (line) => console.log(line),
      });
      return;
    default:
      console.log(warnLine(`unknown command: /${cmd}  (try /help)`));
      return;
  }
}

main().catch((e) => {
  console.error(errorLine((e as Error).message));
  process.exit(1);
});
