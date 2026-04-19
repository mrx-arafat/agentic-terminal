# Agentic Terminal

Folder-scoped AI terminal agent. Like Warp AI — but open-source, runs anywhere, uses **your own API key** (Gemini, Claude, OpenAI) or a **self-hosted Ollama** model.

You `cd` into any folder. You launch `agentic`. The agent works inside that folder like a senior DevOps engineer: reads files, edits code, runs shell commands, greps logs, fixes configs, navigates subfolders — with your approval.

```
~/projects/my-server $ agentic
➜ my-server › my nginx keeps returning 502 on /api, fix it

⚒ bash cat /etc/nginx/nginx.conf
⚒ bash nginx -t
⚒ read_file conf.d/api.conf
⚒ edit_file conf.d/api.conf
⚒ bash nginx -s reload
✓ fixed: upstream port mismatched app bind port (was 3000, app on 3001)
```

## What's new in v0.2.0

- **Rich approval flow** — per-tool approval with `[y]es / [n]o / [a]lways / [s]uggest alternative / Esc`. Reject with Esc, press `a` to always-allow a tool type for the session.
- **Sensitive command detection** — bash commands classified as safe / dangerous / destructive. `--yes` auto-approves dangerous, `--yes-unsafe` approves all. Destructive (rm -rf, drop table, force-push) always prompt.
- **Password-aware execution** — sudo, ssh, docker login, mysql, psql run through PTY so password prompts work.
- **Session tracking** — `/status` shows provider, model, tool count, token usage; `/history` lists recent turns; `/tools` lists all tools.
- **Graceful cancellation** — Ctrl+C during a turn cancels cleanly; model sees rejection and can retry with a different approach.
- **Better setup UX** — per-provider description, API key validation with helpful format hints, optional test-connection.
- **Binary alias** — use `atx` as an alias (shorter than `agentic`).

## Features

- **Folder-aware** — every tool call runs in your current working directory. `cd` inside the session stays sticky.
- **Four providers** — Google Gemini, Anthropic Claude, OpenAI, or Ollama (local / self-hosted).
- **Model catalog** — curated, tiered model lists (small / medium / large / flagship / reasoning). Pick interactively.
- **Real tools** — `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `glob`, `cd`.
- **Smart approval** — interactive approval prompt with multi-tier sensitivity (safe / dangerous / destructive).
- **One-shot mode** — `agentic "fix the bug"` or `atx "fix the bug"` runs a single prompt and exits. Good for scripts / CI.
- **Slash commands** — `/model`, `/provider`, `/cd`, `/status`, `/history`, `/tools`, etc. while chatting.
- **No lock-in** — MIT licensed, bring your own key, zero telemetry.

## Install

```bash
# Run without installing
npx agentic-terminal

# Install globally
npm install -g agentic-terminal
agentic
```

Requires Node.js 18+.

## Quick start

```bash
# One-time setup: pick provider, paste API key, pick model
agentic setup

# Start in current folder
cd ~/projects/my-app
agentic

# One-shot prompt
agentic "summarize the README and list top 3 TODOs in the code"

# Override provider/model for one run
agentic --provider ollama --model qwen2.5:7b
agentic --provider claude --model claude-opus-4-7 --yes

# Use atx alias
atx "debug the crash in production"
```

## Approval flow

When the agent calls a tool, you see an approval prompt:

```
[SAFE] read_file({"path":"package.json"})
  [y]es  [n]o  [a]lways-this-tool  [s]uggest-alternative  Esc=reject: 
```

- **[y]** approve and run this tool
- **[n]** or **Esc** reject; agent gets "rejected by user" and tries a different approach
- **[a]** approve and add this tool to the session's "always-allow" list (forget on exit)
- **[s]** reject and type your suggestion (e.g., "use grep instead"); agent reconsiders

### Sensitivity tiers

Tools are classified as:

- **Safe** — read_file, list_dir, grep, glob, cd. Never prompt.
- **Dangerous** — bash (generic), write_file, edit_file, npm publish, apt install, curl -X POST, sudo. Prompt unless `--yes`.
- **Destructive** — rm -rf, git push --force, drop table, chmod 777, curl | bash. Always prompt, even with `--yes`. Use `--yes-unsafe` to skip.

### Auto-approval

- `agentic --yes` → auto-approve safe + dangerous tools
- `agentic --yes-unsafe` → auto-approve all including destructive (use with caution)
- Inside session, press **[a]** in the approval prompt to always-allow that specific tool for the rest of the session

## Sensitive commands

Destructive bash patterns that always trigger approval:

- `rm -rf`, `mkfs`, `dd of=/dev/sdX` — filesystem destruction
- `git push --force`, `git reset --hard`, `git clean -fd` — version control destruction
- `DROP TABLE`, `TRUNCATE TABLE` — database destruction
- `chmod 777`, `curl | bash`, `ssh-keyscan >> authorized_keys` — security risks

Dangerous patterns that prompt (or auto-approve with `--yes`):

- `sudo` — any privilege escalation
- `ssh`, `scp` — remote execution
- `npm publish` — package publishing
- `kill -9` — process termination
- `apt install`, `brew uninstall` — package management

## Providers

| Provider | Needs key | How to get it |
|----------|-----------|---------------|
| `gemini` | ✅ | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `claude` | ✅ | [console.anthropic.com](https://console.anthropic.com/) |
| `openai` | ✅ | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `ollama` | ❌ | [ollama.com](https://ollama.com/) — runs locally, free |

Keys are stored in `~/.config/agentic-terminal/config.json` (chmod 600) or loaded from env vars:

- `GEMINI_API_KEY` / `GOOGLE_API_KEY`
- `ANTHROPIC_API_KEY` / `CLAUDE_API_KEY`
- `OPENAI_API_KEY`

## Models

Run `agentic models` or `agentic models <provider>` to see the full catalog, grouped by tier:

- **Small / Fast** — cheap, quick, good enough for most tasks
- **Medium / Balanced** — daily driver
- **Large / Strong** — hard reasoning, long context
- **Flagship** — best of each provider
- **Reasoning** — o-series (OpenAI), DeepSeek R1 (Ollama) — think before they answer

You can also pass any custom model id (useful for fine-tunes or new models).

## Slash commands

Inside the interactive session:

```
/help                       show all commands
/status                     show session status (provider, model, cwd, uptime, tokens, always-allow list)
/history                    show recent conversation turns and their tool calls
/tools                      list all available tools and their approval status
/model <id>                 switch model
/provider <name>            switch provider (gemini|claude|openai|ollama)
/models                     list models for current provider
/providers                  list all providers
/cd <path>                  change working directory
/cwd                        show current directory
/clear                      clear conversation history
/save                       persist current session settings to config
/config                     show config path + current settings
/exit                       quit
```

## CLI reference

```
agentic                          start interactive session in current folder
agentic "prompt here"            one-shot run
atx "prompt here"                short alias for agentic (0.2.0+)
agentic setup                    configure provider, API key, model
agentic providers                list supported providers
agentic models [provider]        list models for a provider
agentic config                   print config file path and current settings
agentic --help                   show help
agentic --version                show version

Flags:
  --cwd <path>                   start in specific directory
  --provider <name>              override provider for this run
  --model <id>                   override model for this run
  --yes                          auto-approve safe and dangerous tools (destructive still prompt)
  --yes-unsafe                   auto-approve all tools including destructive (use with caution)
```

## Tools the agent can call

| Tool | What it does | Tier |
|------|--------------|------|
| `bash` | Run a shell command in cwd | Dangerous (or destructive if rm -rf, git push --force, etc.) |
| `read_file` | Read a file | Safe |
| `write_file` | Create/overwrite a file | Dangerous |
| `edit_file` | Replace a unique string in a file | Dangerous |
| `list_dir` | List directory entries | Safe |
| `grep` | Recursive regex search | Safe |
| `glob` | Find files by name pattern | Safe |
| `cd` | Change session cwd | Safe |

See [Approval flow](#approval-flow) and [Sensitive commands](#sensitive-commands) above for how tiers affect prompting.

## Security notes

- API keys sit in `~/.config/agentic-terminal/config.json` with `0600` permissions.
- `bash`, `write_file`, `edit_file` prompt before executing unless `autoApprove` is on.
- The agent only operates in whatever directory you started it in (plus anywhere you `cd` to).
- No telemetry. No remote calls beyond the provider you chose.

## Develop

```bash
git clone https://github.com/mrx-arafat/agentic-terminal
cd agentic-terminal
npm install
npm run dev          # tsx src/index.ts
npm run build        # emit dist/
npm link             # install `agentic` into PATH globally
```

## Roadmap

- [ ] Streaming responses
- [ ] MCP server support
- [ ] Persistent project memory (`.agentic/` per folder)
- [ ] More tools: `web_fetch`, `apply_patch`, `run_tests`
- [ ] Windows PowerShell tool variant

## License

MIT © mrx-arafat
