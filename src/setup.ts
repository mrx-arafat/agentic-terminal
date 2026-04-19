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
import { question, successLine, infoLine, warnLine } from "./ui.js";

const PROVIDER_NAMES: Array<{ key: ProviderName; label: string; needsKey: boolean }> = [
  { key: "gemini", label: "Google Gemini", needsKey: true },
  { key: "claude", label: "Anthropic Claude", needsKey: true },
  { key: "openai", label: "OpenAI", needsKey: true },
  { key: "ollama", label: "Ollama (local, self-hosted)", needsKey: false },
];

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
      console.log(infoLine(`\ncurrent key: ${masked}  (or set ${envLabel} env var)`));
      const key = await question(rl, `Paste API key (leave empty to keep current): `);
      if (key.trim()) {
        if (chosen.key === "gemini") cfg.geminiApiKey = key.trim();
        if (chosen.key === "claude") cfg.claudeApiKey = key.trim();
        if (chosen.key === "openai") cfg.openaiApiKey = key.trim();
      }
    } else {
      const host = await question(rl, `\nOllama host (default ${cfg.ollamaHost}): `);
      if (host.trim()) cfg.ollamaHost = host.trim();
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
