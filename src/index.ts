import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";
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

const VERSION = "0.1.0";

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

${chalk.bold("Examples:")}
  agentic
  agentic "fix the nginx config in ./conf.d"
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
  help: boolean;
  version: boolean;
  rest: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { yes: false, help: false, version: false, rest: [] };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
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

  if (args.prompt) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
      await runTurn({ cfg, provider, ctx, rl, history }, args.prompt);
    } finally {
      rl.close();
    }
    return;
  }

  console.log(banner(provider.name, resolveModel(cfg), ctx.cwd));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.on("SIGINT", () => {
    console.log(infoLine("\n(Ctrl+C) type /exit to quit"));
    rl.prompt();
  });

  const loop = async () => {
    rl.setPrompt(promptPrefix(ctx.cwd));
    rl.prompt();
  };

  await loop();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { await loop(); continue; }

    if (input.startsWith("/")) {
      const done = await handleSlash(input, { cfg, ctx, history });
      if (done === "exit") break;
      await loop();
      continue;
    }

    try {
      await runTurn({ cfg, provider, ctx, rl, history }, input);
    } catch (e) {
      console.log(errorLine((e as Error).message));
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
}

async function handleSlash(input: string, s: SlashCtx): Promise<"exit" | void> {
  const [cmd, ...rest] = input.slice(1).split(/\s+/);
  switch (cmd) {
    case "exit":
    case "quit":
      return "exit";
    case "help":
      console.log(`
${chalk.bold("Slash commands:")}
  /help                       show this help
  /clear                      clear conversation history
  /cwd                        show current working directory
  /cd <path>                  change working directory
  /provider <name>            switch provider (gemini|claude|openai|ollama)
  /model <id>                 switch model
  /models                     list models for current provider
  /providers                  list all providers
  /approve on|off             toggle auto-approval of dangerous tools
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
      console.log(successLine(`provider=${name} model=${resolveModel(s.cfg)} (use /save to persist)`));
      return;
    }
    case "model": {
      const id = rest.join(" ");
      if (!id) { console.log(errorLine("usage: /model <id>")); return; }
      setModel(s.cfg, id);
      console.log(successLine(`model=${id} (use /save to persist)`));
      return;
    }
    case "models":
      printModelList(s.cfg.provider);
      return;
    case "providers":
      printProviderList();
      return;
    case "approve": {
      const v = rest[0];
      if (v === "on") s.cfg.autoApprove = true;
      else if (v === "off") s.cfg.autoApprove = false;
      else { console.log(errorLine("usage: /approve on|off")); return; }
      console.log(successLine(`autoApprove=${s.cfg.autoApprove} (use /save to persist)`));
      return;
    }
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
