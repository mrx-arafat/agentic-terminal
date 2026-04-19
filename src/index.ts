import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
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
import type { Message } from "./providers/types.js";
import type { ToolContext } from "./tools.js";
import { runSetup, printModelList, printProviderList } from "./setup.js";
import { runTurn } from "./agent.js";
import { banner, errorLine, infoLine, promptPrefix, successLine, warnLine } from "./ui.js";
import { createSession, formatStatus, formatHistory, type SessionState } from "./session.js";
import { TOOL_DEFS } from "./tools.js";
import { CancelError } from "./approval.js";
import { loadSkills, mergeSkills } from "./skills/loader.js";
import type { Skill } from "./skills/types.js";
import { MemoryStore } from "./memory/store.js";
import { detectProjectType, getProjectName } from "./memory/detector.js";

const VERSION = "0.3.0";

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
    else positional.push(a);
  }
  const subcommands = new Set(["setup", "providers", "models", "config"]);
  if (positional[0] && subcommands.has(positional[0])) {
    out.subcommand = positional[0];
    out.rest = positional.slice(1);
  } else if (positional.length > 0) {
    out.prompt = positional.join(" ");
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
  const globalDir = path.join(os.homedir(), ".config", "agentic-terminal", "skills");
  const projectDir = path.join(cwd, ".agentic", "skills");
  const [global, project] = await Promise.all([
    loadSkills(globalDir),
    loadSkills(projectDir),
  ]);
  return mergeSkills(global, project);
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
  if (cfg.provider !== "ollama" && !apiKey) {
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

  const ctx: ToolContext = { cwd };
  const history: Message[] = [];
  const session = createSession(cfg, provider.name, ctx.cwd, args.yesUnsafe);

  const skills = await loadAllSkills(cwd);

  const memStore = new MemoryStore(path.join(os.homedir(), ".agentic", "projects"));
  const projectName = getProjectName(cwd);
  const projectType = detectProjectType(cwd);
  const mem = await memStore.load(projectName) ?? await memStore.initialize(projectName, projectType, cwd);
  void mem; // available for future use

  if (args.prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const controller = new AbortController();
    try {
      await runTurn({ cfg, provider, ctx, rl, history, session, abortSignal: controller.signal, skills }, args.prompt);
    } catch (e) {
      if (e instanceof CancelError || (e as Error).name === "CancelError") {
        controller.abort();
        console.log(warnLine("(cancelled)"));
      } else {
        throw e;
      }
    } finally {
      rl.close();
    }
    return;
  }

  console.log(banner(provider.name, resolveModel(cfg), ctx.cwd));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  function onIdleSigint() {
    console.log(infoLine("\n(Ctrl+C) type /exit to quit"));
    rl.prompt();
  }
  rl.on("SIGINT", onIdleSigint);

  const loop = async () => {
    rl.setPrompt(promptPrefix(ctx.cwd));
    rl.prompt();
  };

  await loop();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { await loop(); continue; }

    if (input.startsWith("/")) {
      const done = await handleSlash(input, { cfg, ctx, history, session, skills });
      if (done === "exit") break;
      await loop();
      continue;
    }

    rl.removeListener("SIGINT", onIdleSigint);
    const controller = new AbortController();
    const onTurnSigint = () => {
      controller.abort();
      console.log(infoLine("(^C — cancelling after current tool)"));
    };
    rl.on("SIGINT", onTurnSigint);

    try {
      await runTurn({ cfg, provider, ctx, rl, history, session, abortSignal: controller.signal, skills }, input);
    } catch (e) {
      if (e instanceof CancelError || (e as Error).name === "CancelError") {
        controller.abort();
        console.log(warnLine("(cancelled)"));
      } else {
        console.log(errorLine((e as Error).message));
      }
    } finally {
      rl.removeListener("SIGINT", onTurnSigint);
      rl.on("SIGINT", onIdleSigint);
    }
    await loop();
  }

  rl.close();
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
${chalk.bold("Slash commands:")}
  /help                       show this help
  /skills                     list loaded skills
  /status                     show current session status
  /history                    show conversation history and tool calls
  /tools                      list all available tools and their approval status
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
        console.log(errorLine(`usage: /provider gemini|claude|openai|ollama`));
        return;
      }
      s.cfg.provider = name;
      s.session.provider = name;
      s.session.model = resolveModel(s.cfg);
      console.log(successLine(`provider=${name} model=${resolveModel(s.cfg)} (use /save to persist)`));
      return;
    }
    case "model": {
      const id = rest.join(" ");
      if (!id) { console.log(errorLine("usage: /model <id>")); return; }
      setModel(s.cfg, id);
      s.session.model = id;
      console.log(successLine(`model=${id} (use /save to persist)`));
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
    case "tools":
      console.log(chalk.bold("Available Tools:"));
      for (const t of TOOL_DEFS) {
        const allowed = s.session.alwaysAllow.has(t.name) ? chalk.green("(always allow)") : "";
        console.log(`  ${chalk.cyan(t.name)} ${allowed}`);
      }
      return;
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
    default:
      console.log(warnLine(`unknown command: /${cmd}  (try /help)`));
      return;
  }
}

main().catch((e) => {
  console.error(errorLine((e as Error).message));
  process.exit(1);
});
