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

## Features

- **Folder-aware** — every tool call runs in your current working directory. `cd` inside the session stays sticky.
- **Four providers** — Google Gemini, Anthropic Claude, OpenAI, or Ollama (local / self-hosted).
- **Model catalog** — curated, tiered model lists (small / medium / large / flagship / reasoning). Pick interactively.
- **Real tools** — `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `glob`, `cd`.
- **Safe by default** — destructive tools (shell, write, edit) ask for confirmation. Toggle with `/approve on`.
- **One-shot mode** — `agentic "fix the bug"` runs a single prompt and exits. Good for scripts / CI.
- **Slash commands** — `/model`, `/provider`, `/cd`, `/clear`, `/save`, etc. while chatting.
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
```

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
/model <id>                 switch model
/provider <name>            switch provider (gemini|claude|openai|ollama)
/models                     list models for current provider
/providers                  list all providers
/cd <path>                  change working directory
/cwd                        show current directory
/clear                      clear conversation history
/approve on|off             toggle auto-approval of bash/write/edit
/save                       persist current session settings to config
/config                     show config path + current settings
/exit                       quit
```

## CLI reference

```
agentic                          start interactive session in current folder
agentic "prompt here"            one-shot run
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
  --yes                          auto-approve dangerous tools
```

## Tools the agent can call

| Tool | What it does | Confirm? |
|------|--------------|----------|
| `bash` | Run a shell command in cwd | ✅ |
| `read_file` | Read a file | — |
| `write_file` | Create/overwrite a file | ✅ |
| `edit_file` | Replace a unique string in a file | ✅ |
| `list_dir` | List directory entries | — |
| `grep` | Recursive regex search | — |
| `glob` | Find files by name pattern | — |
| `cd` | Change session cwd | — |

Confirmation can be disabled per-session with `/approve on` or globally via `agentic setup`.

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
