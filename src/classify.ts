import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type InputKind = "slash" | "shell" | "ai" | "empty";

export interface Classification {
  kind: InputKind;
  /** What to send to the shell (kind=shell) or LLM (kind=ai). Prefix stripped. */
  payload: string;
  /** Why this classification was picked — shown as a dim hint on ambiguous inputs. */
  reason?: string;
}

/** Unambiguous shell builtins. Deliberately excludes English-verb collisions
 *  like `read`, `test`, `type`, `source`, `.`, `[`, `true`, `false`, `wait`,
 *  `eval`, `return`, `shift`, `times`, `help` — those are handled as
 *  ambiguous heads below. */
const SHELL_BUILTINS = new Set([
  "cd", "pwd", "echo", "export", "unset", "set", "alias", "unalias",
  "which", "exec", "exit", "kill", "jobs", "fg", "bg", "history",
  "umask", "ulimit", "trap", "pushd", "popd", "dirs", "time",
]);

/** Common, obviously-shell tools. Kept small on purpose — PATH probe handles the rest. */
const SHELL_HINTS = new Set([
  "ls", "cat", "head", "tail", "less", "more", "grep", "rg",
  "fd", "awk", "sed", "tr", "sort", "uniq", "wc", "cut", "tee",
  "git", "gh", "hub", "npm", "npx", "pnpm", "yarn", "bun", "node", "deno",
  "python", "python3", "pip", "pip3", "uv", "poetry", "pipx",
  "ruby", "rails", "bundle", "gem", "rbenv",
  "go", "cargo", "rustc", "rustup",
  "php", "composer", "artisan", "symfony",
  "docker", "podman", "kubectl", "k9s", "helm", "minikube", "kind",
  "terraform", "ansible", "vagrant",
  "curl", "wget", "http", "httpie", "jq", "yq", "xmllint",
  "cmake", "ninja", "bazel", "gradle", "mvn",
  "ssh", "scp", "sftp", "rsync", "tmux", "screen", "nvim", "vim", "vi", "nano", "emacs",
  "ps", "top", "htop", "df", "du", "free", "uptime", "who", "w", "whoami", "id",
  "chmod", "chown", "sudo", "su", "uname", "hostname", "date", "env", "printenv",
  "tar", "zip", "unzip", "gzip", "gunzip", "xz", "bzip2",
  "brew", "apt", "apt-get", "yum", "dnf", "pacman", "zypper",
  "systemctl", "service", "launchctl", "journalctl",
  "pbcopy", "pbpaste", "code", "cursor", "pwsh",
  "clear", "reset",
]);

/** English-verb commands. Classify as shell only if the rest of the line has
 *  a shell-ish shape (flag, path, operator). Otherwise → AI. */
const AMBIGUOUS_HEADS = new Set([
  "read", "write", "make", "build", "run", "open", "show", "find", "test",
  "install", "fix", "explain", "add", "remove", "delete", "update", "create",
  "generate", "refactor", "check", "start", "stop", "restart", "deploy",
]);

let PATH_CACHE: Set<string> | null = null;

function pathExecutables(): Set<string> {
  if (PATH_CACHE) return PATH_CACHE;
  const cache = new Set<string>();
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  for (const p of paths) {
    if (!p) continue;
    try {
      for (const name of fs.readdirSync(p)) {
        cache.add(name);
      }
    } catch {
      // dir missing or unreadable
    }
  }
  PATH_CACHE = cache;
  return cache;
}

function isOnPath(name: string): boolean {
  // Fast path: cached directory listing
  if (pathExecutables().has(name)) return true;
  // Slow path: `command -v` handles aliases/functions/builtins shell-side
  try {
    execFileSync("bash", ["-lc", `command -v ${JSON.stringify(name)}`], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 500,
    });
    return true;
  } catch {
    return false;
  }
}

function tokenizeHead(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed) return null;
  const m = trimmed.match(/^([^\s;&|<>]+)/);
  return m ? m[1] : null;
}

/** Classify a raw input line. */
export function classify(input: string): Classification {
  const raw = input ?? "";
  const trimmed = raw.trim();

  if (!trimmed) return { kind: "empty", payload: "" };

  // Slash command: `/word` where word is a single alnum token — not a path.
  if (/^\/[a-zA-Z][a-zA-Z0-9_-]*(\s|$)/.test(trimmed)) {
    return { kind: "slash", payload: trimmed };
  }

  // Explicit overrides
  if (trimmed.startsWith("!")) {
    return { kind: "shell", payload: trimmed.slice(1).trimStart(), reason: "`!` prefix" };
  }
  if (trimmed.startsWith("#") || trimmed.startsWith("?")) {
    return { kind: "ai", payload: trimmed.slice(1).trimStart(), reason: `\`${trimmed[0]}\` prefix` };
  }

  // Sentence-shape detection: capital-letter head + sentence-ending punctuation,
  // OR any line ending in "?" (a question), is natural language.
  if (/^[A-Z][a-z]/.test(trimmed) && /[.!?]$/.test(trimmed)) {
    return { kind: "ai", payload: trimmed, reason: "sentence shape" };
  }
  if (/\?$/.test(trimmed)) {
    return { kind: "ai", payload: trimmed, reason: "question mark" };
  }

  const headRaw = tokenizeHead(trimmed);
  if (!headRaw) return { kind: "ai", payload: trimmed };
  const head = headRaw.toLowerCase();
  // Strip trailing sentence punctuation from the tail so `read all files.` works.
  const restRaw = trimmed.slice(headRaw.length).trimStart();
  const rest = restRaw.replace(/[.!?]+$/, "").trimEnd();

  // Env-var assignment prefix (FOO=bar cmd ...) → shell (checked before NL cue)
  if (/^[A-Z_][A-Z0-9_]*=/.test(headRaw)) {
    return { kind: "shell", payload: trimmed, reason: "env-var prefix" };
  }
  // Path-like first token (./foo, ../foo, /usr/local/bin/foo) → shell
  if (/^(\.\/|\.\.\/|\/)/.test(headRaw)) {
    return { kind: "shell", payload: trimmed, reason: "path-like command" };
  }

  // Ambiguous English-verb heads: classify shell only if tail is shell-shaped.
  if (AMBIGUOUS_HEADS.has(head)) {
    if (looksLikeShellTail(rest)) {
      return { kind: "shell", payload: trimmed, reason: `ambiguous \`${head}\` with shell args` };
    }
    return { kind: "ai", payload: trimmed, reason: `\`${head}\` reads as natural language` };
  }

  // Prose override — multi-word sentence with English glue words beats any
  // command-name collision (e.g., `node is a runtime for the server`).
  const wordCount = trimmed.split(/\s+/).length;
  if (wordCount >= 3 && hasEnglishGlue(rest)) {
    return { kind: "ai", payload: trimmed, reason: "prose with glue words" };
  }

  if (SHELL_BUILTINS.has(head)) {
    return { kind: "shell", payload: trimmed, reason: `shell builtin \`${head}\`` };
  }
  if (SHELL_HINTS.has(head)) {
    return { kind: "shell", payload: trimmed, reason: `known command \`${head}\`` };
  }

  // Clear natural-language signals → AI
  const hasNLCue = /[?]|(^|\s)(please|how|why|what|explain|show me|tell me|can you|could you|summarize|describe)(\s|$)/i.test(trimmed);
  if (hasNLCue && wordCount >= 3) {
    return { kind: "ai", payload: trimmed, reason: "natural-language cue" };
  }

  if (isOnPath(headRaw)) {
    return { kind: "shell", payload: trimmed, reason: `\`${headRaw}\` on PATH` };
  }

  // Default: AI prompt
  return { kind: "ai", payload: trimmed };
}

function hasEnglishGlue(tail: string): boolean {
  for (const t of tail.split(/\s+/)) {
    if (ENGLISH_GLUE.has(t.toLowerCase())) return true;
  }
  return false;
}

const ENGLISH_GLUE = new Set([
  "the", "a", "an", "all", "any", "some", "my", "your", "this", "that",
  "these", "those", "and", "or", "but", "in", "on", "of", "to", "for",
  "with", "from", "into", "about", "please", "me", "it", "them",
]);

/** True if the tail looks like shell args (has flags, paths, operators, quotes, globs). */
function looksLikeShellTail(tail: string): boolean {
  if (!tail) return false;
  const tokens = tail.split(/\s+/).filter(Boolean);

  // Any English glue word → natural language, not shell.
  if (tokens.some((t) => ENGLISH_GLUE.has(t.toLowerCase()))) return false;

  // Shell-ish markers: -flag, --flag, /, ./, ../, pipe, redirect, &, ;, $, =, `, quotes, glob chars
  if (/(^|\s)-[A-Za-z-]/.test(tail)) return true;
  if (/[/\\*?|<>&;$`'"]|=/.test(tail)) return true;
  // Single arg after verb (e.g., `kill 1234`, `test -f`, `make build`, `open README.md`)
  if (tokens.length === 1) return true;
  return false;
}

/** Reset PATH cache — call when env changes during a long session. */
export function resetPathCache(): void {
  PATH_CACHE = null;
}
