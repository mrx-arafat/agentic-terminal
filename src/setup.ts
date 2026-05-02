import readline from "node:readline";
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
import { MODEL_CATALOG, TIER_LABEL, TIER_ORDER, groupByTier } from "./models.js";
import { question, successLine, infoLine, warnLine, errorLine } from "./ui.js";
import { createProvider } from "./providers/factory.js";

const PROVIDER_NAMES: Array<{ key: ProviderName; label: string; needsKey: boolean }> = [
  { key: "gemini", label: "Google Gemini", needsKey: true },
  { key: "claude", label: "Anthropic Claude", needsKey: true },
  { key: "openai", label: "OpenAI", needsKey: true },
  { key: "ollama", label: "Ollama (local, self-hosted)", needsKey: false },
  { key: "claude-cli", label: "Claude Code CLI (uses your Claude subscription)", needsKey: false },
];

const PROVIDER_BLURB: Record<ProviderName, string> = {
  gemini: "Fast, 1M token context, best free tier. Great for DevOps and long-file tasks.",
  claude: "Most capable and thoughtful. Best for complex reasoning and code review.",
  openai: "Reliable and widely compatible. Good for general tasks and integrations.",
  ollama: "Run locally on your machine. No API keys needed, completely private.",
  "claude-cli": "Uses your installed Claude Code CLI. Auths via Claude subscription. Tools via prompt engineering.",
};

function validateApiKey(provider: ProviderName, key: string): { ok: boolean; reason?: string } {
  if (!key) return { ok: false, reason: "key is empty" };
  switch (provider) {
    case "gemini":
      if (!/^AIza[0-9A-Za-z_\-]{35}$/.test(key)) {
        return { ok: false, reason: "Gemini keys start with 'AIza' and are 39 chars" };
      }
      return { ok: true };
    case "claude":
      if (!/^sk-ant-[a-zA-Z0-9_\-]{50,}$/.test(key)) {
        return { ok: false, reason: "Claude keys start with 'sk-ant-' and are at least 55 chars" };
      }
      return { ok: true };
    case "openai":
      if (!/^sk-[a-zA-Z0-9_\-]{20,}$/.test(key)) {
        return { ok: false, reason: "OpenAI keys start with 'sk-' and are at least 23 chars" };
      }
      return { ok: true };
    default:
      return { ok: true };
  }
}

export async function runSetup(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cfg = loadConfig();

  try {
    console.log(chalk.bold.cyan("\nAgentic Terminal setup\n"));
    console.log(infoLine(`config: ${configPath()}\n`));

    console.log(chalk.bold("Choose provider:"));
    PROVIDER_NAMES.forEach((p, i) => {
      const current = p.key === cfg.provider ? chalk.green(" (current)") : "";
      console.log(`  ${i + 1}. ${p.label}${current}`);
    });

    const pick = await question(rl, `\nSelect [1-${PROVIDER_NAMES.length}] (default ${PROVIDER_NAMES.findIndex((p) => p.key === cfg.provider) + 1}): `);
    const idx = pick.trim() === "" ? PROVIDER_NAMES.findIndex((p) => p.key === cfg.provider) : parseInt(pick, 10) - 1;
    const chosen = PROVIDER_NAMES[idx] ?? PROVIDER_NAMES[0];
    cfg.provider = chosen.key;

    if (chosen.needsKey) {
      const existing = resolveApiKey(cfg);
      const envLabel =
        chosen.key === "gemini" ? "GEMINI_API_KEY" :
        chosen.key === "claude" ? "ANTHROPIC_API_KEY" :
        "OPENAI_API_KEY";
      const masked = existing ? `${existing.slice(0, 4)}…${existing.slice(-4)}` : "none";
      console.log(infoLine(`\n${PROVIDER_BLURB[chosen.key]}`));
      console.log(infoLine(`current key: ${masked}  (or set ${envLabel} env var)`));
      const key = await question(rl, `Paste API key (leave empty to keep current): `);
      if (key.trim()) {
        const validation = validateApiKey(chosen.key, key.trim());
        if (!validation.ok) {
          console.log(warnLine(`key doesn't match expected format (${validation.reason}) — continuing anyway`));
        }
        if (chosen.key === "gemini") cfg.geminiApiKey = key.trim();
        if (chosen.key === "claude") cfg.claudeApiKey = key.trim();
        if (chosen.key === "openai") cfg.openaiApiKey = key.trim();
      }
      const testConn = await question(rl, `\nTest connection now? [y/N]: `);
      if (testConn.trim().toLowerCase().startsWith("y")) {
        await testConnection(cfg);
      }
    } else if (chosen.key === "ollama") {
      const host = await question(rl, `\nOllama host (default ${cfg.ollamaHost}): `);
      if (host.trim()) cfg.ollamaHost = host.trim();
    } else if (chosen.key === "claude-cli") {
      console.log(infoLine(`\n${PROVIDER_BLURB[chosen.key]}`));
      const bin = await question(rl, `Claude CLI binary path (default ${cfg.claudeCliBinary ?? "claude"}): `);
      if (bin.trim()) cfg.claudeCliBinary = bin.trim();
    }

    await pickModel(rl, cfg);

    const approve = await question(rl, `\nAuto-approve dangerous tools (bash, write, edit)? [y/N]: `);
    cfg.autoApprove = approve.trim().toLowerCase().startsWith("y");

    saveConfig(cfg);
    console.log(successLine(`saved to ${configPath()}`));
    console.log(infoLine(`provider=${cfg.provider}  model=${resolveModel(cfg)}  autoApprove=${cfg.autoApprove}`));
  } finally {
    rl.close();
  }
}

async function pickModel(rl: readline.Interface, cfg: Config): Promise<void> {
  const grouped = groupByTier(cfg.provider);
  const flat = TIER_ORDER.flatMap((tier) => grouped[tier].map((m) => ({ tier, m })));

  console.log(chalk.bold(`\nChoose model (${cfg.provider}):`));
  let i = 1;
  let currentTier: string | null = null;
  const lookup: Array<{ id: string }> = [];
  for (const { tier, m } of flat) {
    if (tier !== currentTier) {
      console.log(chalk.gray(`\n  — ${TIER_LABEL[tier]} —`));
      currentTier = tier;
    }
    const current = m.id === resolveModel(cfg) ? chalk.green(" (current)") : "";
    const notes = m.notes ? chalk.gray(`  [${m.notes}]`) : "";
    console.log(`  ${i.toString().padStart(2)}. ${m.label} ${chalk.gray(m.id)}${notes}${current}`);
    lookup.push({ id: m.id });
    i++;
  }
  console.log(chalk.gray(`   0. Enter custom model id`));

  const pick = await question(rl, `\nSelect [0-${lookup.length}] (leave empty to keep current): `);
  const n = parseInt(pick, 10);
  if (pick.trim() === "" || Number.isNaN(n)) return;
  if (n === 0) {
    const custom = await question(rl, `Custom model id: `);
    if (custom.trim()) setModel(cfg, custom.trim());
    return;
  }
  const selected = lookup[n - 1];
  if (selected) setModel(cfg, selected.id);
  else console.log(warnLine(`invalid selection, keeping current`));
}

export function printModelList(provider: ProviderName): void {
  const grouped = groupByTier(provider);
  console.log(chalk.bold(`\n${provider} models:`));
  for (const tier of TIER_ORDER) {
    if (grouped[tier].length === 0) continue;
    console.log(chalk.gray(`\n  — ${TIER_LABEL[tier]} —`));
    for (const m of grouped[tier]) {
      const notes = m.notes ? chalk.gray(`  [${m.notes}]`) : "";
      console.log(`    ${m.label.padEnd(28)} ${chalk.cyan(m.id)}${notes}`);
    }
  }
  console.log();
}

export function printProviderList(): void {
  console.log(chalk.bold("\nSupported providers:\n"));
  for (const p of PROVIDER_NAMES) {
    const count = MODEL_CATALOG[p.key].length;
    const auth = p.needsKey ? chalk.gray("(API key)") : chalk.gray("(local)");
    console.log(`  ${chalk.cyan(p.key.padEnd(8))}${p.label.padEnd(32)}${count} models  ${auth}`);
  }
  console.log();
}

async function testConnection(cfg: Config): Promise<void> {
  try {
    const provider = createProvider(cfg);
    const response = await provider.chat(
      [{ role: "user", content: "ping" }],
      []
    );
    if (response.text || response.toolCalls !== undefined) {
      console.log(successLine("connection ok"));
    } else {
      console.log(warnLine("connection returned empty response"));
    }
  } catch (e) {
    console.log(errorLine(`connection failed: ${(e as Error).message}`));
    console.log(infoLine("check your API key or network connection"));
  }
}
