# Agentic Terminal

An open-source, folder-scoped AI terminal agent. `cd` into any project, launch `agentic`, and get a senior engineer in your terminal — one prompt builds the app, installs the deps, runs the tests, and serves it, all with your approval. Type `ls`, `git status`, or any shell command and it runs as a real shell. Type an English sentence and the AI handles it. No mode switch.

Bring your own API key (Gemini, Claude, OpenAI) or run fully local with Ollama. Zero telemetry. MIT licensed.

```
~/projects $ agentic
➜ projects git:(main) › create a simple todo app
⚒ todo_write         5 steps planned
⚒ bash               npm create vite@latest simple-todo-app -- --template react --no-git
⚒ cd                 simple-todo-app
⚒ bash               npm install
⚒ write_file         src/App.jsx  (todo UI with localStorage)
⚒ bash               npm run build
⚒ list_dir           dist/
╭─ agent
│ ✓ Todo app ready at simple-todo-app/
│
│ ## Next
│ cd simple-todo-app && npm run dev   # Vite on :5173
╰─
```

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [What's New in v0.6.0](#whats-new-in-v060)
- [What's New in v0.5.1](#whats-new-in-v051)
- [What's New in v0.5.0](#whats-new-in-v050)
- [Dual-mode Input: Shell + AI](#dual-mode-input-shell--ai)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Features](#features)
- [Providers](#providers)
- [Models](#models)
- [Approval Flow](#approval-flow)
- [Tools Reference](#tools-reference)
- [Slash Commands](#slash-commands)
- [CLI Reference](#cli-reference)
- [Configuration Reference](#configuration-reference)
- [Skills System](#skills-system)
- [MCP Integration](#mcp-integration)
- [Project Memory](#project-memory)
- [Recipes](#recipes)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [FAQ](#faq)
- [Security](#security)
- [Develop](#develop)
- [License](#license)

---

## Install

```bash
# Run without installing (tries immediately)
npx agentic-terminal

# Install globally
npm install -g agentic-terminal
```

Requires **Node.js 18+**.

---

## Quick Start

```bash
# 1. One-time setup: pick provider, paste API key, pick model
agentic setup

# 2. cd into your project
cd ~/projects/my-app

# 3. Start the agent
agentic

# One-shot prompt (no interactive session)
agentic "summarize the README and list top 3 TODOs"

# Short alias
atx "debug the crash in production.log"
```

That's it. The agent will read your files, propose changes, and ask for your approval before anything dangerous runs.

---

## What's New in v0.6.0

### Polished tool-call cards
Tool output got a redesign. Each call now renders as a single-line card with status glyph, name, smart per-tool summary, stat chips, and right-aligned duration. The header replaces the previous double-print of `⚒ name` + `✓ name` and the raw-JSON args dump.

```text
●  read_file  src/ui.ts                            180 lines  done · 0.1s
●  edit_file  src/ui.ts                              +42 -7   done · 0.4s
▏  @@ -127,4 +127,8 @@
▏  - export function toolLine(name, args) {
▏  + export function renderToolCard(call) {
▏  … 38 more lines
●  bash  npm test -- --silent                        exit 0   done · 4.7s
▏  Tests: 253 passed, 0 failed
✕  bash  npm run build                              exit 1   failed · 2.3s
▏  src/ui.ts(146,12): TS2304: Cannot find name 'renderCard'.
```

While a tool runs, the header line redraws in place with a `◐` spinner and live elapsed time, then morphs into `●` (done) or `✕` (failed) when finished. Per-tool formatters give human summaries: `todo_write` shows `N tasks · X done · Y active`, `read_file` shows the path + line count, `edit_file` shows `+N -M` diff stats, `bash` shows the command + exit code, `grep` shows pattern + match count. MCP tools render with their most identifying arg.

Parallel tool batches print `◐ Running N tools…` and then render each card as the batch resolves.

### Shift+Enter for newline
You can now press `shift+enter` at the prompt to insert a newline (in addition to the existing `alt+enter` and trailing `\`). The CLI auto-enables the kitty keyboard protocol on startup and parses both `CSI 27;2;13~` (xterm modifyOtherKeys) and `CSI 13;2u` (kitty CSI u) — modern terminals (Warp, Ghostty, WezTerm, kitty, foot, recent iTerm2/Alacritty) just work. Older terminals ignore the request and fall back to `alt+enter` cleanly.

The protocol is popped on exit (and on abnormal exit via `process.on("exit")`) so your terminal never stays in a modified state.

### Internal cleanup
- New `src/tool-card.ts` (renderer + spinner lifecycle) and `src/tool-formatters.ts` (per-tool presentation)
- Old `toolLine`, `toolResult`, `previewArgs` removed from `src/ui.ts`
- Test suite grew to 253 tests (added 76 for the new modules)

---

## What's New in v0.5.1

### Esc to interrupt a running turn
Pressing **Esc** while the AI is thinking (or while it's executing tool calls) aborts the current turn and hands the prompt back to you instantly — no waiting for the model or network. The history stays valid: every in-flight tool call is recorded with `cancelled by user`, and the next message is auto-tagged with a resume hint so the model picks up exactly where it left off. Ctrl+C does the same thing. Works across all four providers (Gemini, Claude, OpenAI, Ollama).

Under the hood: dual-path detection (`keypress` for post-readline and raw-byte `data` events for instant response), forced raw-mode while a turn is active so bare Esc isn't line-buffered, and `\x1b\x1b` / `\x1b` both accepted for terminal-compatibility.

### Smarter resume-word classification
`continue`, `resume`, `proceed`, `go on`, `keep going`, `carry on`, `retry`, `try again`, `break`, and `return` now always route to the AI — never the shell. Previously `continue` triggered `bash: continue: only meaningful in a 'for', 'while', or 'until' loop` because it's a bash builtin that passes `command -v`. Now you can interrupt a turn with Esc and just type `continue` to resume.

### Debug mode for keystroke inspection
Set `AGENTIC_DEBUG_KEYS=1` to print every keypress and raw data byte stdin receives, with active-turn state. Useful if Esc doesn't fire on your terminal — paste the hex output and it's easy to add your terminal's escape code.

```bash
AGENTIC_DEBUG_KEYS=1 agentic
```

---

## What's New in v0.5.0

### Dual-mode input: shell and AI in one prompt
No mode switch. Type `ls`, `git status`, `cd foo` and the line runs as a real shell command with live output. Type `create a todo app` and it goes to the AI. The classifier reads the first token, checks PATH, weighs English glue words, and routes automatically. Use `!` / `#` to force a lane.

### `read_all` — one-shot recursive reader
`read all files` / `walk me through the repo` now calls a single tool that walks the directory, skips `node_modules` / `.git` / binaries, concatenates the text files with headers, and returns everything in one shot. Weak models no longer get lost orchestrating `list_dir` + `read_file` loops.

### Background processes
`bash background=true` detaches the command, streams its output to `.agentic/bg/<id>.log`, and returns immediately. Pairs with `bg_list` / `bg_logs` / `bg_stop` for dev servers, watchers, long builds.

### Resume after interrupt
Hit `Ctrl+C` mid-work. Every in-flight tool call gets a `cancelled by user` result so history stays valid. The next message (`continue`, `finish it`, or anything else) sees a resume hint in the system prompt and picks up exactly where you left off — including weaker models.

### Auto-fallback: `edit_file` on empty files writes
Models used to error-loop when they called `edit_file` on a brand-new empty file. Now `edit_file` / `multi_edit` on an empty or missing target automatically writes instead. Error messages on real edit misuse now tell the model what to do next (`use write_file`, `read_file first`).

### Built-in `scaffold-web-app` skill
Triggers on `create react/next/vite/vue/svelte/astro/todo/blog/dashboard/landing/...`. The skill spells the non-interactive scaffold command, enforces a `scaffold → cd → install → implement → build → verify` flow, and prevents "I stopped at boilerplate" behaviour.

### Nicer AI rendering
AI replies render in a boxed `╭─ agent / ╰─` panel with a left gutter. Fenced code blocks are syntax-highlighted per language (`cli-highlight`) inside their own `┌─ lang / └─` frame. Headings, bold, italic, inline code, links, and blockquotes all have distinct colors. Shell command output sits outside the panel.

### Quality-of-life
- Git branch in prompt: `➜ ~/Devs/app git:(main) ›`
- `cd` tab-completion on directories; file completion on other commands
- `did you mean: cd <closest-match>` on typos
- Live braille spinner with elapsed seconds replaces static `thinking…`
- 3-minute Ollama timeout so the agent never hangs forever
- Tool-message payloads clipped to 6 KB when sent to Ollama (keeps 7B context healthy)
- Stack-aware wrap-up — HTML gets `open index.html`, Vite gets `npm run dev`, Flask gets `flask run`, etc.

---

## Dual-mode Input: Shell + AI

Every line you type is routed to one of three lanes. The classifier runs locally — no model call needed.

| You type | Lane | Why |
|---|---|---|
| `ls -la` | shell | first token is a real binary |
| `cd files` | shell | shell builtin, updates the agent's cwd |
| `git status` | shell | known tool name |
| `NODE_ENV=prod npm run build` | shell | env-var prefix |
| `./run.sh` | shell | path-like head |
| `/help` | slash command | leading `/word` |
| `!echo forced` | shell | explicit override |
| `#explain this code` | ai | explicit override |
| `create a todo app` | ai | natural-language cue |
| `read all files` | ai | ambiguous English verb + prose |
| `The fuck is this?` | ai | sentence shape |
| `find . -name '*.ts'` | shell | `find` with shell-shaped args |
| `find the bug in main.ts` | ai | `find` followed by prose |

When the call could have gone either way, a dim hint shows why: `» shell (\`!\` prefix)` or `» ai (\`find\` reads as natural language)`. For obvious cases the hint is suppressed.

---

## Keyboard Shortcuts

### At the prompt (idle)

| Key | Action |
|-----|--------|
| `Enter` | Submit |
| `Shift+Enter` / `Alt+Enter` / trailing `\` | Insert a newline |
| `Tab` | Completion — directories for `cd`/`pushd`, files/commands elsewhere |
| `↑` / `↓` | Walk prompt history (readline default) |
| `Ctrl+A` / `Ctrl+E` | Start / end of line |
| `Ctrl+U` | Clear current input line |
| `Ctrl+W` | Delete previous word |
| `Ctrl+L` | Clear screen |
| `Ctrl+C` | Cancel current input line — type `/exit` to quit |
| `Ctrl+D` | EOF — quit the session |

`Shift+Enter` works in modern terminals (Warp, Ghostty, WezTerm, kitty, foot, recent iTerm2/Alacritty) without any config — the CLI auto-enables the kitty keyboard protocol on startup. Older terminals ignore the request; use `Alt+Enter` instead.

### While a turn is running (AI is thinking or tools are executing)

| Key | Action |
|-----|--------|
| `Esc` | **Interrupt the turn.** In-flight tool calls get `cancelled by user`, history stays valid, prompt returns. |
| `Ctrl+C` | Same as Esc — interrupt the turn. |

After an interrupt, the next message you send is auto-tagged with a resume hint so the model continues the original plan if you say `continue`, `go on`, or similar — or pivots if you give it a new instruction.

### In the approval prompt (when a dangerous tool fires)

| Key | Action |
|-----|--------|
| `y` | Approve and run |
| `n` | Reject — agent gets "rejected by user" |
| `a` | Approve and always-allow this tool for the rest of the session |
| `s` | Reject and type a suggested alternative |
| `Esc` | Reject + abort the whole turn |

---

## Features

| Feature | Description |
|---------|-------------|
| **Dual-mode input** | Shell commands and AI prompts in the same REPL, auto-classified. |
| **Folder-scoped** | Every tool runs in your `cwd`. `cd` (as shell or slash) stays sticky across turns. |
| **4 providers** | Gemini, Claude, OpenAI, or Ollama (local/self-hosted). |
| **Resumable interrupts** | Ctrl+C never leaves the conversation in a broken state; next message resumes. |
| **Skills** | Auto-triggered reusable instruction sets per task type. Ships with `scaffold-web-app`. |
| **MCP servers** | Connect external tools via Model Context Protocol. |
| **Project memory** | Cross-session learning: stack detection, error patterns, tool stats. |
| **Real tools** | `bash` (foreground & background), `read_file`, `read_all`, `write_file`, `edit_file`, `multi_edit`, `create_dir`, `delete_file`, `delete_dir`, `move_path`, `copy_path`, `list_dir`, `grep`, `glob`, `cd`, `todo_write`, `bg_list`, `bg_logs`, `bg_stop`. |
| **Smart approval** | 3-tier sensitivity (safe / dangerous / destructive) with interactive prompt. |
| **Styled output** | Boxed AI panel, syntax-highlighted code fences, colored markdown, git-aware prompt. |
| **One-shot mode** | `agentic "prompt"` for scripts and CI pipelines. |
| **Slash commands** | `/model`, `/provider`, `/cd`, `/skills`, `/status`, `/history`, `/blocks`, `/mcp`, and more. |
| **Tab completion** | File paths on every command; directories only for `cd`/`pushd`. |
| **No lock-in** | MIT licensed, no telemetry, your keys stay local. |

---

## Providers

| Provider | Key required | How to get one |
|----------|-------------|----------------|
| `gemini` | Yes | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| `claude` | Yes | [console.anthropic.com](https://console.anthropic.com/) |
| `openai` | Yes | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| `ollama` | No | [ollama.com](https://ollama.com/) — runs 100% locally |

Keys are stored at `~/.config/agentic-terminal/config.json` (chmod 600).

You can also set them as environment variables:

```bash
export GEMINI_API_KEY=...        # or GOOGLE_API_KEY
export ANTHROPIC_API_KEY=...     # or CLAUDE_API_KEY
export OPENAI_API_KEY=...
```

---

## Models

```bash
agentic models              # list models for current provider
agentic models gemini       # list all Gemini models
agentic models ollama       # list Ollama models
```

Models are grouped by tier:

| Tier | Description |
|------|-------------|
| **Small / Fast** | Cheap and quick. Good for simple tasks. |
| **Medium / Balanced** | The daily driver. Best cost/quality ratio. |
| **Large / Strong** | Hard reasoning, long context. |
| **Flagship** | The best each provider offers. |
| **Reasoning** | Think before answering (o-series, DeepSeek R1). |

You can also pass any custom model ID — useful for fine-tunes or newly released models:

```bash
agentic --model gemini-2.0-flash-exp
```

---

## Approval Flow

Every tool call goes through a 3-tier approval system before executing.

### Tiers

| Tier | Examples | Default behavior |
|------|----------|-----------------|
| **Safe** | `read_file`, `read_all`, `list_dir`, `grep`, `glob`, `cd`, `bg_list`, `bg_logs` | Runs silently, no prompt |
| **Dangerous** | `bash` (including `background=true`), `write_file`, `edit_file`, `multi_edit`, `create_dir`, `move_path`, `copy_path`, `bg_stop`, `sudo`, `curl -X POST`, `npm publish` | Prompts — or auto-approves with `--yes` |
| **Destructive** | `delete_file`, `delete_dir`, `rm -rf`, `git push --force`, `DROP TABLE`, `chmod 777`, `curl \| bash` | Always prompts — even with `--yes`. Use `--yes-unsafe` to skip. |

### Interactive prompt

When a dangerous tool fires, you see:

```
[DANGEROUS] bash {"cmd":"npm run deploy"}
  [y]es  [n]o  [a]lways-this-tool  [s]uggest-alternative  Esc=reject:
```

| Key | Action |
|-----|--------|
| `y` | Approve and run |
| `n` or `Esc` | Reject — agent gets "rejected by user" and tries differently |
| `a` | Approve and always-allow this tool for the rest of the session |
| `s` | Reject and type a suggestion; agent reconsiders |

### Auto-approval flags

```bash
agentic --yes          # auto-approve safe + dangerous (destructive still prompt)
agentic --yes-unsafe   # auto-approve everything including destructive (use carefully)
```

---

## Tools Reference

### Read/Explore (Safe)
| Tool | What it does |
|------|-------------|
| `read_file` | Read file contents with 1-based line numbers, offset/limit paging |
| `read_all` | Recursive bulk reader: walks a dir, skips `node_modules`/`.git`/binaries, returns every text file concatenated with headers. Capped at 50 files × 20 KB/file by default. |
| `list_dir` | List directory contents |
| `grep` | Recursive regex search (ripgrep when available, smart-case, type/glob filters) |
| `glob` | Find files by name pattern (globstar `**` supported) |
| `cd` | Change the session's working directory (sticky) |

### Write/Edit (Dangerous)
| Tool | What it does |
|------|-------------|
| `write_file` | Create or overwrite a file (preferred for new files) |
| `edit_file` | Replace one unique occurrence of `old_string`. On empty/missing files it auto-falls-back to a write. |
| `multi_edit` | Batch atomic edits to one file (all-or-nothing). On empty files with empty `old_string`s it writes the concatenated `new_string`s. |

### File/Folder Ops (Dangerous or Destructive)
| Tool | What it does | Tier |
|------|-------------|------|
| `create_dir` | Create directory with parents (idempotent) | Dangerous |
| `move_path` | Move or rename file/directory | Dangerous |
| `copy_path` | Copy file/directory recursively | Dangerous |
| `delete_file` | Remove a single file | **Destructive** |
| `delete_dir` | Remove a directory (recursive flag optional) | **Destructive** |

### Shell (Dangerous)
| Tool | What it does |
|------|-------------|
| `bash` | Run a shell command in cwd. Pass `timeout` in ms (default 120 000). |
| `bash background=true` | Detach the command, return immediately with `id` + `pid` + `logPath` under `.agentic/bg/`. |
| `bg_list` | List background processes and their status. Safe. |
| `bg_logs` | Tail a background process's combined stdout+stderr log. Safe. |
| `bg_stop` | Terminate a background process (SIGTERM or `force=true` for SIGKILL). Dangerous. |

Password-requiring commands (`sudo`, `ssh`, `docker login`, `mysql`, `psql`) run through a PTY so interactive prompts work correctly.

### Planning
| Tool | What it does |
|------|-------------|
| `todo_write` | Write or replace the session's plan. Each todo has `id`, `content`, `status` (`pending`/`in_progress`/`done`). Visible via `/todos`. |

---

## Slash Commands

Available while in an interactive session (`agentic` with no prompt):

```
/help                    show all commands
/skills                  list loaded skills
/skills <name>           show details of a specific skill
/status                  session status (provider, model, cwd, tokens, uptime)
/history                 recent conversation turns and tool calls
/tools                   list all tools and their always-allow status
/blocks                  list bash command blocks (command, exit, duration) run this session
/block <id>              show the full captured output of a block
/todos                   show the current plan
/context                 show auto-detected project context summary
/mcp                     list MCP servers and status
/mcp connect <name>      (re)connect an MCP server
/mcp disconnect <name>   disconnect an MCP server
/mcp tools [server]      list MCP tools (optionally filter by server)
/model <id>              switch model mid-session
/provider <name>         switch provider (gemini|claude|openai|ollama)
/models                  list models for current provider
/providers               list all providers
/cd <path>               change working directory
/cwd                     show current directory
/clear                   clear conversation history
/save                    save current provider/model to config file
/config                  show config path and current settings
/exit                    quit
```

---

## CLI Reference

```
agentic                        start interactive session in current folder
agentic "prompt"               one-shot: run prompt and exit
atx "prompt"                   short alias for agentic
agentic setup                  configure provider, API key, and model
agentic providers              list supported providers
agentic models [provider]      list models for a provider
agentic config                 print config path and current settings
agentic --help                 show help
agentic --version              show version

Flags:
  --cwd <path>                 start in a specific directory
  --provider <name>            override provider for this run
  --model <id>                 override model for this run
  --yes                        auto-approve safe + dangerous tools
  --yes-unsafe                 auto-approve all tools including destructive
```

---

## Configuration Reference

### Config file

Path: `~/.config/agentic-terminal/config.json` (chmod 0600).

```json
{
  "provider": "ollama",
  "geminiApiKey": "...",
  "claudeApiKey": "...",
  "openaiApiKey": "...",
  "models": {
    "gemini": "gemini-2.5-flash",
    "claude": "claude-sonnet-4-5",
    "openai": "gpt-4o-mini",
    "ollama": "qwen2.5:latest"
  },
  "autoApprove": false,
  "maxIterations": 25
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `provider` | `"gemini" \| "claude" \| "openai" \| "ollama"` | `gemini` | Active provider |
| `geminiApiKey` | string | — | Google AI Studio key |
| `claudeApiKey` | string | — | Anthropic key |
| `openaiApiKey` | string | — | OpenAI key |
| `models.<provider>` | string | per-provider default | Active model per provider |
| `autoApprove` | bool | `false` | Auto-approve safe + dangerous (same as `--yes`) |
| `maxIterations` | number | `25` | Max tool-call iterations per turn before giving up |

Edit via `agentic setup`, slash commands (`/provider`, `/model`, `/save`), or directly in the JSON file.

### Environment variables

Env vars always override the config file.

| Variable | Purpose |
|----------|---------|
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini API key |
| `ANTHROPIC_API_KEY` or `CLAUDE_API_KEY` | Claude API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `OLLAMA_HOST` | Override Ollama endpoint (default `http://localhost:11434`) |
| `AGENTIC_DEBUG_KEYS=1` | Dump every keystroke / raw byte to stderr (Esc troubleshooting) |
| `NO_COLOR=1` | Disable all ANSI colors in output |
| `FORCE_COLOR=1` | Force colors even when stdout isn't a TTY |

### Per-project files

| Path | Purpose |
|------|---------|
| `.agentic-rules.md` | Standing instructions injected into every turn |
| `.agentic/skills/<name>/SKILL.md` | Project-local skill (overrides global skills by name) |
| `.agentic/mcp.json` | Project-local MCP server config (overrides global) |
| `.agentic/bg/<id>.log` | Logs for background processes started with `bash background=true` |

### Per-user files

| Path | Purpose |
|------|---------|
| `~/.config/agentic-terminal/config.json` | Provider + model + API keys |
| `~/.config/agentic-terminal/skills/<name>/SKILL.md` | Global skills available everywhere |
| `~/.config/agentic-terminal/mcp.json` | Global MCP servers |
| `~/.agentic/projects/<name>.json` | Per-project memory (stack, error patterns, tool stats) |

---

## Skills System

Skills let you encode reusable, task-specific instructions that the agent automatically picks up based on what you type.

### How it works

1. You create a `SKILL.md` file with a YAML frontmatter header
2. On every turn, the agent checks if your input matches any skill's trigger patterns
3. If matched, the skill's instructions are injected into the system prompt for that turn
4. The most specific match (longest trigger pattern) wins

### Creating a skill

```
.agentic/skills/
  docker-debug/
    SKILL.md
  deploy/
    SKILL.md
    scripts/
      pre-deploy.sh
    references/
      checklist.md
```

**SKILL.md format:**

```markdown
---
name: docker-debug
description: Expert Docker debugging — containers, networks, volumes
trigger_patterns:
  - docker
  - container
  - "container.*not.*start"
  - dockerfile
---

When debugging Docker issues:
1. Always check `docker ps -a` and `docker logs <container>` first
2. Inspect with `docker inspect <container>` for network/volume config
3. For build failures, run `docker build --no-cache` and read the layer output
4. Check `docker stats` for resource constraints
```

### Frontmatter fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier (used in `/skills <name>`) |
| `description` | Yes | Short human-readable summary |
| `trigger_patterns` | Yes | List of strings or regex patterns to match user input |
| `mcp` | No | Name of an MCP server this skill expects to be available |

### Skill directories

Skills are loaded from two locations and merged (project overrides global by name):

| Location | Scope |
|----------|-------|
| `~/.config/agentic-terminal/skills/` | Global — available in every project |
| `.agentic/skills/` | Project — committed to your repo, shared with your team |

### Using scripts and references

Inside a skill directory, you can add:

- `scripts/` — shell scripts the agent knows about and can run
- `references/` — markdown files, checklists, runbooks the agent can read

The agent's system prompt will list these files so it knows they exist.

### Listing skills

```bash
/skills                  # list all loaded skills
/skills docker-debug     # show trigger patterns and description for a skill
```

---

## MCP Integration

[Model Context Protocol](https://modelcontextprotocol.io) lets you connect external servers that expose tools — filesystem access, GitHub, databases, Slack, and anything else the community builds.

### Config files

| File | Scope |
|------|-------|
| `~/.config/agentic-terminal/mcp.json` | Global — all projects |
| `.agentic/mcp.json` | Project — overrides global servers by name |

### Config format

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "my-api": {
      "url": "http://localhost:3100/mcp"
    }
  }
}
```

### Environment variable substitution

Any `${VAR_NAME}` in string values is replaced with the matching environment variable at runtime. This keeps secrets out of config files.

### Transport types

| Type | Config field | Use when |
|------|-------------|----------|
| stdio | `command` + `args` | Most MCP servers (npm packages, local binaries) |
| HTTP | `url` | Remote or self-hosted MCP servers |

---

## Project Memory

The agent learns about your project and persists that knowledge across sessions.

### What gets stored

Memory lives at `~/.agentic/projects/<project-name>.json` and tracks:

| Field | Description |
|-------|-------------|
| `projectType` | Auto-detected stack: `node`, `python`, `go`, `rust`, `java`, `php`, `ruby`, or `unknown` |
| `commonErrors` | Error patterns seen, suggested fixes, confidence scores, success rates |
| `toolPatterns` | Which tools work well, average durations, success rates |
| `projectRules` | Contents of `.agentic-rules.md` if present |

### Stack detection

The agent detects your stack from marker files:

| Marker file | Detected as |
|-------------|------------|
| `package.json` | `node` |
| `pyproject.toml`, `requirements.txt`, `setup.py` | `python` |
| `go.mod` | `go` |
| `Cargo.toml` | `rust` |
| `pom.xml`, `build.gradle` | `java` |
| `composer.json` | `php` |
| `Gemfile` | `ruby` |

### Project rules

Create `.agentic-rules.md` in your project root to give the agent standing instructions:

```markdown
# Project Rules

- Always run `npm test` after editing any `.ts` file
- Never edit files under `generated/` — they are auto-generated
- The API lives at `src/api/` — all routes must be registered in `src/api/router.ts`
- Use `pnpm` not `npm` for all package operations
```

---

## Recipes

Practical patterns for day-to-day work. Each one assumes you're at `agentic`'s interactive prompt inside a project.

### Scaffold a React app and run it

```
create a React app called inventory-ui and run the dev server in the background
```

One prompt. The built-in `scaffold-web-app` skill picks the right `npm create vite` flags, installs deps, launches the dev server with `bash background=true`, and tells you the port.

### Explain a codebase you've never seen

```
walk me through this repo
```

Calls `read_all` with a 30-file cap, then summarizes architecture, entry points, and noteworthy patterns. No `list_dir → read_file → list_dir` ping-pong.

### Debug a failing test

```
run npm test and fix whatever breaks
```

The agent runs tests, reads the first failing stack frame, opens the relevant source file, proposes a fix, and re-runs. If it needs more than one iteration, it updates the todo list so you can watch progress with `/todos`.

### Fix a bug you can describe but can't locate

```
there's a race condition in the websocket reconnect logic — find it and fix it
```

`grep` for websocket/reconnect handlers → `read_file` the hot spots → propose a diff. The diff shows as a preview before the `edit_file` approval prompt.

### Batch-rename across a codebase

```
rename getUserById to loadUser everywhere, including tests
```

`grep` finds call sites → `multi_edit` applies all changes atomically. If any single edit fails the whole batch rolls back.

### Try a command without committing

Press Esc mid-run if the approach is wrong:

```
migrate all the CSS modules to Tailwind
# agent starts ... press Esc
# prompt returns; type:
on second thought, just do the buttons in src/components/
```

History is preserved. The model sees the cancelled tool calls and the new instruction.

### Run a long-running dev server

```
bash npm run dev background=true
```

The server stays up across turns. Check its logs anytime:

```
/blocks
/bg_logs 0
```

Kill it when done:

```
bg_stop 0
```

### Shell + AI on the same line

```
➜ my-app › git status
# (shell output)

➜ my-app › what changed in the last commit?
# (AI reads git log + diff and summarizes)
```

No mode switch. Classifier routes automatically.

### One-shot for scripts and CI

```bash
agentic --yes "update the changelog with everything since v0.5.0" > out.log
```

`--yes` auto-approves safe + dangerous. Destructive tools still prompt — use `--yes-unsafe` for full unattended.

---

## Architecture

### Process model

```
agentic (CLI)
 └─ main REPL (readline)
    ├─ classifier      → slash / shell / ai
    ├─ shell runner    → spawn bash -lc (sync) or node-pty (sudo/ssh/...)
    ├─ slash handler   → in-process commands (/model, /cd, /skills, ...)
    └─ agent.runTurn() → provider chat → tool loop → approval prompt
       ├─ tools        → read_file, bash, edit_file, ... (in-process)
       └─ mcp tools    → JSON-RPC over stdio or HTTP to external servers
```

Turn control flow:

1. User submits a line → classifier routes to one of three lanes.
2. AI lane: a fresh `AbortController` wraps the turn. Its signal is threaded into every provider request and every tool call.
3. `provider.chat()` runs the model. Returns text + tool calls.
4. Safe, read-only tool calls run in parallel. Side-effect tools run in order.
5. Each result is pushed back into history as a `role: tool` message with the matching `toolCallId`.
6. Loop until the model returns no more tool calls, or `abortSignal.aborted === true`, or `maxIterations` is reached.

On Esc / Ctrl+C, the abort controller fires. Any in-flight `fetch` unwinds, any pending serial tool is skipped, and the `finally` block writes a `cancelled by user` entry for every tool call that didn't complete — so the assistant↔tool pairing in the conversation history stays valid for the next turn.

### Interrupt path (Esc / Ctrl+C)

```
keypress 'escape'  ─┐
raw 0x1b byte     ─┼─► wireEscInterrupt → turnAbort.abort() ─► AbortSignal
readline SIGINT   ─┘                                           │
                                                               ▼
                                            ┌───────────┬────────────┐
                                            │ fetch     │ tool loop  │
                                            │ aborts    │ skips      │
                                            └───────────┴────────────┘
                                                    │
                                                    ▼
                                   history: role=tool, result="cancelled by user"
                                                    │
                                                    ▼
                                   next turn: buildResumeHint() tags system prompt
```

### Why three-path Esc detection

Different terminals deliver Esc differently. We support all of them:

1. `keypress` event — after Node's ~500 ms escape-code disambiguation window, fires with `key.name === 'escape'`.
2. `data` event with `\x1b` — raw single ESC byte, instant.
3. `data` event with `\x1b\x1b` — double-ESC (some terminals meta-prefix bare Esc), instant.

Forcing `setRawMode(true)` while a turn is active ensures bare Esc isn't line-buffered.

### Source map

| Module | Purpose |
|--------|---------|
| `src/index.ts` | CLI parse, session init, main REPL loop, slash dispatcher, interrupt wiring |
| `src/classify.ts` | Routes each input line to slash / shell / ai / empty |
| `src/agent.ts` | `runTurn` — provider chat + tool loop + resume hint builder |
| `src/tools.ts` | All native tool definitions and handlers |
| `src/approval.ts` | Interactive approval prompt + `CancelError` |
| `src/sensitivity.ts` | Classifies each tool call as safe / dangerous / destructive |
| `src/interrupt.ts` | Esc detection (keypress + raw bytes), raw-mode management |
| `src/preview.ts` | Diff previews for file-modifying tools |
| `src/pty.ts` | `node-pty` wrapper for interactive commands (`sudo`, `ssh`, …) |
| `src/shell.ts` | Tab completion + `cd` typo suggestions |
| `src/session.ts` | Token counts, tool counts, turn history |
| `src/context.ts` | Auto-detects project stack + builds a context summary |
| `src/providers/` | Gemini / Claude / OpenAI / Ollama adapters |
| `src/skills/` | Skills loader, trigger matcher, system-prompt injection |
| `src/mcp/` | MCP server config loader and JSON-RPC client |
| `src/memory/` | Per-project memory store + stack detection |
| `src/ui.ts` | Markdown rendering, syntax highlighting, boxed panels |
| `src/tool-card.ts` | Tool-call card renderer + spinner lifecycle |
| `src/tool-formatters.ts` | Per-tool presentation (summary, body, chips) |

---

## Troubleshooting

### Esc doesn't interrupt the turn

1. Confirm you're on **0.5.1 or newer**: `agentic --version`.
2. If you installed from source, rebuild — the `agentic` binary runs `dist/`, not `src/`:
   ```bash
   cd <your-clone>
   npm run build
   ```
3. Run with debug mode to see what your terminal sends:
   ```bash
   AGENTIC_DEBUG_KEYS=1 agentic
   ```
   Press Esc during a turn. Each keystroke prints `[dbg] data len=N hex=... active=...` to stderr. If you see something other than `1b` or `1b 1b`, open an issue with the output.

### `continue` / `resume` runs in the shell instead of the AI

You're on < 0.5.1. Upgrade (`npm install -g agentic-terminal@latest`). v0.5.1 short-circuits loop-builtin words before the PATH probe.

### `no API key for <provider>`

Either run `agentic setup` to configure one, set the matching env var (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), or switch to Ollama: `agentic --provider ollama`.

### `reached max iterations (25); stopping`

Default is 25 tool-call iterations per turn. Bump in `~/.config/agentic-terminal/config.json`:
```json
{ "maxIterations": 50 }
```

### Ollama hangs or times out

Ollama requests use a 3-minute timeout. For 70B+ models on CPU, that may not be enough. Work around it by using a smaller model (`qwen2.5:7b`, `llama3.2`) or streaming-friendly setups. Also confirm `ollama serve` is running: `curl localhost:11434/api/tags`.

### Scaffolders (Vite, create-next-app) fail with "Operation cancelled"

They detect a non-TTY stdin and bail. The `bash` tool already closes stdin so they see EOF — if you still hit this, pass `--yes` flags where available, or run the command inside an interactive shell: `bash -lic "npm create vite@latest myapp -- --template react"`.

### Large `npm install` / `pytest` calls time out

The `bash` tool's default timeout is 120 s. In a prompt you can ask the agent to pass `timeout: 600000` (10 minutes):

```
run npm install with a 10-minute timeout
```

### Tab completion doesn't show anything

Happens when stdin isn't a TTY (piped input, nested emulator). Confirm `process.stdin.isTTY` is `true`:
```bash
node -e "console.log(process.stdin.isTTY)"
```

### `command not found: agentic` after install

Global bin wasn't added to PATH. Either:
```bash
echo 'export PATH="$(npm bin -g):$PATH"' >> ~/.zshrc
```
or use `npx agentic-terminal`.

---

## FAQ

### How is this different from Claude Code / Cursor / Aider?

**Folder-scoped and provider-agnostic.** Claude Code is Anthropic-only; Cursor is an IDE; Aider needs git. Agentic Terminal runs in any folder, supports four providers, ships with MCP + skills + project memory, and has dual-mode shell+AI input so you don't keep switching windows.

### Does it send my code anywhere?

Only to the provider you picked. No telemetry, no analytics, no intermediate servers. If you run Ollama it never leaves your machine.

### Are my API keys safe?

Stored at `~/.config/agentic-terminal/config.json` with `chmod 0600`. They're never logged, never echoed back, and never sent anywhere except the matching provider's API. Environment variables always take precedence over the config file.

### Can I run it in CI?

Yes. One-shot mode + `--yes` (or `--yes-unsafe`) + a non-interactive provider:
```bash
agentic --yes --provider openai --model gpt-4o-mini "run tests and update the changelog"
```

### Can I use my own model / fine-tune?

`agentic --model my-custom-id`. The CLI passes the ID through verbatim to the provider. For Ollama, any model you've pulled with `ollama pull` works.

### How do I stop the agent from touching certain files?

Put them in a `.gitignore`-like rules file: `.agentic-rules.md` in your project root. The agent reads it on startup and treats it as standing instructions.

### Can I script it?

Yes — the one-shot mode (`agentic "prompt"`) is designed for scripts. Combine with `--yes` / `--yes-unsafe` for unattended runs. Stdout is the agent's final text output; tool traces go to stderr.

### Does it work on Windows?

Works under WSL2 (treat it as Linux). Native Windows (PowerShell / cmd) isn't supported yet — it's on the roadmap.

### Why does it sometimes re-read the same file?

When your `cwd` changes between turns, previous `list_dir` / `read_file` results no longer describe the current location. The system prompt tells the model to re-probe after a `cd`. This is intentional — stale context causes worse bugs.

### Can I disable approval prompts for a trusted project?

`agentic --yes` for safe + dangerous, `agentic --yes-unsafe` for everything including destructive. You can also press `a` in any approval prompt to always-allow that specific tool for the rest of the session.

### How do I contribute?

Fork, PR, open issues. See the `Develop` section below for test/build commands.

---

## Security

- API keys stored at `~/.config/agentic-terminal/config.json` with `0600` permissions
- `bash`, `write_file`, `edit_file` always prompt unless you explicitly pass `--yes` or `--yes-unsafe`
- Destructive commands **always** prompt regardless of flags
- The agent only operates in the directory you started it in (or wherever you `/cd` during the session)
- No telemetry. No analytics. No remote calls beyond the AI provider you chose.
- MCP `${VAR_NAME}` substitution reads from your environment — secrets never touch config files

---

## Develop

```bash
git clone https://github.com/mrx-arafat/agentic-terminal
cd agentic-terminal
npm install

npm run dev          # run from source with tsx (no build step)
npm run build        # compile TypeScript → dist/
npm test             # run test suite (vitest)
npm test -- --watch  # watch mode
npm link             # install `agentic` globally from local source
```

### Project structure

```
src/
  index.ts          entry point, CLI parsing, session loop
  agent.ts          turn runner, tool dispatch, approval flow
  tools.ts          tool definitions and handlers
  config.ts         config load/save
  session.ts        session state tracking
  skills/           skills loader, trigger matcher, executor
  mcp/              MCP config loader and types
  memory/           project memory store and detector
  providers/        Gemini, Claude, OpenAI, Ollama adapters
tests/
  skills/           unit tests for skills system
  mcp/              unit tests for MCP config loader
  memory/           unit tests for memory store and detector
```

### Running tests

```bash
npm test                        # run all tests once
npm run test:watch              # watch mode for development
```

All 253 tests should pass. If they don't, open an issue.

---

## Roadmap

- [x] Rich approval flow with per-tool sensitivity tiers
- [x] PTY support for password-requiring commands
- [x] Session tracking (tokens, tool counts, history)
- [x] Skills system — reusable, auto-triggered instruction sets
- [x] MCP config loading — connect any MCP server
- [x] Project memory — cross-session stack detection and learning
- [x] Session persistence — interactive sessions stay open across turns
- [x] File/folder tools — `create_dir`, `delete_file`, `delete_dir`, `move_path`, `copy_path`, `multi_edit`
- [x] Dual-mode input (shell + AI auto-routed) with `!` / `#` overrides
- [x] `read_all` bulk reader with binary/skip-dir handling
- [x] Background processes — `bash background=true`, `bg_list`, `bg_logs`, `bg_stop`
- [x] Resume-after-interrupt: Ctrl+C never breaks history
- [x] Esc-to-interrupt with dual-path detection (v0.5.1)
- [x] Resume-word classification (`continue`, `go on`, `retry` …) always routes to AI (v0.5.1)
- [x] Styled AI output with syntax-highlighted code fences and a boxed panel
- [x] Git branch in prompt, tab-completion, `did you mean` on cd typos
- [x] Built-in `scaffold-web-app` skill for end-to-end project creation
- [x] Polished tool-call cards with status pills, smart per-tool summaries, in-place spinner (v0.6.0)
- [x] Shift+Enter newline via kitty keyboard protocol auto-enable (v0.6.0)
- [ ] Streaming responses with live token rendering
- [ ] MCP server spawning and live tool injection
- [ ] More tools: `web_fetch`, `apply_patch`, `run_tests`
- [ ] Windows PowerShell tool variant
- [ ] Web UI for memory and skill management

---

## License

MIT © [mrx-arafat](https://github.com/mrx-arafat)
