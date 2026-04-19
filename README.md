# Agentic Terminal

An open-source, folder-scoped AI terminal agent. `cd` into any project, launch `agentic`, and get a senior DevOps engineer in your terminal — reads files, edits code, runs shell commands, fixes configs, all with your approval.

Bring your own API key (Gemini, Claude, OpenAI) or run fully local with Ollama. Zero telemetry. MIT licensed.

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

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [What's New in v0.3.0](#whats-new-in-v030)
- [Features](#features)
- [Providers](#providers)
- [Models](#models)
- [Approval Flow](#approval-flow)
- [Tools Reference](#tools-reference)
- [Slash Commands](#slash-commands)
- [CLI Reference](#cli-reference)
- [Skills System](#skills-system)
- [MCP Integration](#mcp-integration)
- [Project Memory](#project-memory)
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

## What's New in v0.3.0

### Skills System
Give the agent persistent, reusable instructions scoped to a task type. Drop a `SKILL.md` file in `.agentic/skills/` and the agent auto-loads it whenever your input matches its trigger patterns. See [Skills System](#skills-system).

### MCP Integration
Connect any [Model Context Protocol](https://modelcontextprotocol.io) server — filesystem, databases, GitHub, Slack, anything. Global config at `~/.config/agentic-terminal/mcp.json`, project-level at `.agentic/mcp.json`. See [MCP Integration](#mcp-integration).

### Project Memory
The agent now remembers your project across sessions. It detects your stack (Node, Python, Go, Rust, etc.), records which errors it has seen, and tracks tool effectiveness — so it gets smarter the more you use it. See [Project Memory](#project-memory).

---

## Features

| Feature | Description |
|---------|-------------|
| **Folder-scoped** | Every tool runs in your `cwd`. `/cd` inside a session stays sticky. |
| **4 providers** | Gemini, Claude, OpenAI, or Ollama (local/self-hosted). |
| **Skills** | Auto-triggered reusable instruction sets per task type. |
| **MCP servers** | Connect external tools via Model Context Protocol. |
| **Project memory** | Cross-session learning: stack detection, error patterns, tool stats. |
| **Real tools** | `bash`, `read_file`, `write_file`, `edit_file`, `list_dir`, `grep`, `glob`, `cd`. |
| **Smart approval** | 3-tier sensitivity (safe / dangerous / destructive) with interactive prompt. |
| **One-shot mode** | `agentic "prompt"` for scripts and CI pipelines. |
| **Slash commands** | `/model`, `/provider`, `/cd`, `/skills`, `/status`, `/history`, and more. |
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
| **Safe** | `read_file`, `list_dir`, `grep`, `glob`, `cd` | Runs silently, no prompt |
| **Dangerous** | `bash` (generic), `write_file`, `edit_file`, `sudo`, `curl`, `npm publish` | Prompts — or auto-approves with `--yes` |
| **Destructive** | `rm -rf`, `git push --force`, `DROP TABLE`, `chmod 777`, `curl \| bash` | Always prompts — even with `--yes`. Use `--yes-unsafe` to skip. |

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

| Tool | What it does | Tier |
|------|-------------|------|
| `bash` | Run a shell command in cwd | Dangerous (destructive if rm -rf, force-push, etc.) |
| `read_file` | Read a file | Safe |
| `write_file` | Create or overwrite a file | Dangerous |
| `edit_file` | Replace a unique string in a file | Dangerous |
| `list_dir` | List directory contents | Safe |
| `grep` | Recursive regex search across files | Safe |
| `glob` | Find files matching a pattern | Safe |
| `cd` | Change session working directory | Safe |

Password-requiring commands (`sudo`, `ssh`, `docker login`, `mysql`, `psql`) run through a PTY so interactive prompts work correctly.

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

All 61 tests should pass. If they don't, open an issue.

---

## Roadmap

- [x] Rich approval flow with per-tool sensitivity tiers
- [x] PTY support for password-requiring commands
- [x] Session tracking (tokens, tool counts, history)
- [x] Skills system — reusable, auto-triggered instruction sets
- [x] MCP config loading — connect any MCP server
- [x] Project memory — cross-session stack detection and learning
- [ ] MCP server spawning and live tool injection
- [ ] Streaming responses
- [ ] More tools: `web_fetch`, `apply_patch`, `run_tests`
- [ ] Windows PowerShell tool variant
- [ ] Web UI for memory and skill management

---

## License

MIT © [mrx-arafat](https://github.com/mrx-arafat)
