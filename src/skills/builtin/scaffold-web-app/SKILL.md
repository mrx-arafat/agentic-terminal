---
name: scaffold-web-app
description: Create a new web/JS app (React, Next.js, Vite, Svelte, Vue, Astro, Node CLI) end-to-end — folder, scaffold, install, build, verify.
trigger_patterns:
  - "create (a |an )?(simple |basic |minimal )?react"
  - "scaffold (a |an )?react"
  - "new react (app|project)"
  - "create (a |an )?(simple |basic |minimal )?next"
  - "scaffold (a |an )?next"
  - "new next(\\.js)? (app|project)"
  - "create (a |an )?vite"
  - "scaffold (a |an )?vite"
  - "create (a |an )?svelte"
  - "create (a |an )?(sveltekit|vue|nuxt|astro)"
  - "create (a |an )?node (cli|app)"
  - "create (a |an )?(ts|typescript) (app|project|cli)"
  - "bootstrap (a |an )?(web|js|ts) app"
  - "create (a |an )?(simple |basic |minimal )?(todo|to-do|to do|notes?|blog|chat|counter|weather|calculator|landing( page)?|url shortener|markdown editor|kanban|pomodoro|timer|stopwatch|quiz|trivia|dashboard|portfolio) app"
  - "build (me )?(a |an )?(simple |basic |minimal )?(todo|to-do|notes?|blog|chat|counter|weather|calculator|landing( page)?|kanban|dashboard|portfolio) (app|site|page)"
  - "make (me )?(a |an )?(simple |basic |minimal )?(todo|to-do|notes?|blog|chat|counter|weather|calculator|landing( page)?|kanban|dashboard|portfolio) (app|site|page)"
---

# Scaffold Web App

The user wants a new web/JS project created end-to-end. Treat the user's wording as the intent — fill in anything they omitted with sensible defaults and proceed without asking.

## Inference defaults

| Missing detail | Default |
|---|---|
| Folder name | kebab-case of the request. "simple React app" → `simple-react-app`. "todo list in Next" → `todo-list`. |
| Starting directory | Current cwd. If the target folder already exists and is non-empty, pick `<slug>-2` (or ask only if the existing folder has work in it). |
| React stack | Vite + React (JS). "TypeScript" or "TS" anywhere → `--template react-ts`. |
| Next.js stack | App Router + TS + ESLint, no src dir, no Tailwind unless asked. |
| Vue / Svelte / Astro | Official create-* scaffolders with TS default off unless asked. |
| Package manager | `npm` unless a lockfile of another PM is already present. |

## Scaffold vs. feature app

Scaffolding is necessary but **not sufficient** when the user named a concrete app kind ("todo app", "blog", "chat", "counter", "weather app", "landing page", "url shortener", etc.). Scaffolding only creates the default boilerplate screen — it does not implement what the user asked for. After scaffolding you MUST edit the default entry component (`src/App.jsx`/`src/App.tsx`/`app/page.tsx` etc.) to actually implement the feature, with clean UI, sensible styling, and working state. Only skip this step when the user literally asked for "just a blank React app" / "empty scaffold" / "starter template".

## Canonical workflow

1. **Plan** — call `todo_write` with these steps (only include ones that apply):
   - scaffold project
   - install deps
   - **implement the requested feature** (edit App component + any helper files)
   - production build
   - verify build artifacts
   - (optional) start dev server in background and smoke-test
2. **Scaffold** — one non-interactive command, e.g.:
   - React (JS):   `npm create vite@latest <name> -- --template react --no-git`
   - React (TS):   `npm create vite@latest <name> -- --template react-ts --no-git`
   - Next.js:       `npx --yes create-next-app@latest <name> --ts --eslint --app --no-src-dir --no-tailwind --use-npm`
   - Vue:           `npm create vite@latest <name> -- --template vue`
   - Svelte:        `npm create vite@latest <name> -- --template svelte`
   - Astro:         `npm create astro@latest <name> -- --template minimal --yes --no-install --no-git`
   Always pass `timeout: 600000` on bash.
3. **Enter project** — `cd <name>` (tool call), not `cd` inside a bash string.
4. **Install** — `bash command='npm install' timeout=600000`.
5. **Implement feature** — when the user asked for a named app kind:
   - `read_file src/App.jsx` (or `.tsx` / `app/page.tsx`) to see the boilerplate.
   - `write_file` (overwrite) with a working implementation using React state (`useState`, `useEffect`) for interactivity. Persist to `localStorage` for todo / note / list apps. Keep it single-file when possible.
   - Optionally overwrite `src/App.css` with minimal, readable styling.
   - Do NOT leave the Vite/CRA counter demo in place for a todo/blog/chat/etc. request.
6. **Build** — `bash command='npm run build' timeout=600000`. Skip for plain Node CLIs.
7. **Verify** — `list_dir dist` (Vite) or `list_dir .next` (Next) or `list_dir build`; confirm an `index.html` / `server.js` / expected entry exists.
8. **(Optional) Run & probe** — if the user said "run it" / "start it" / "test it":
   - `bash command='npm run dev' background=true` (or `npm run preview` for Vite prod)
   - wait a moment, then `bash command='curl -sI http://localhost:<port>'` — **Vite dev defaults to 5173** (not 3000), Vite preview to 4173, Next dev to 3000.
   - `bg_logs id=<id>` to inspect; leave it running unless the user asked to stop — then `bg_stop id=<id>`.
8. **Report** — final message: project path, framework, how to start (`cd <name> && npm run dev`), port, and any notable warnings from install/build.

## Hard rules

- Never run an interactive scaffolder without the flags that suppress prompts. If a scaffold hangs, kill it with `bg_stop` and retry with the right flags.
- Never overwrite an existing non-empty folder silently. Pick a new name or ask.
- Don't install global toolchains (`npm i -g ...`, `brew install ...`) unless the user explicitly asks.
- When install/build fails, read the error, fix the root cause (wrong Node version, missing peer, typo in flag), and retry — don't just repeat the same command.
