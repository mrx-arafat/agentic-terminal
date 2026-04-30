/** Push text to the OS clipboard via OSC 52. Works in iTerm2, kitty, WezTerm,
 *  Ghostty, recent Alacritty, Warp, and tmux (with `set -g set-clipboard on`).
 *  Silent no-op on terminals that don't honor OSC 52 — there is no reliable
 *  ack mechanism in raw TTY mode. */
export function copyToClipboard(text: string): void {
  const b64 = Buffer.from(text, "utf8").toString("base64");
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
}

const KNOWN_OSC52_TERMINALS = new Set<string>([
  "WarpTerminal",
  "iTerm.app",
  "ghostty",
  "WezTerm",
  "kitty",
]);

/** Heuristic: does the current TERM_PROGRAM likely honor OSC 52?
 *  Used to decide whether to surface a hint to the user. */
export function likelySupportsOsc52(env: NodeJS.ProcessEnv = process.env): boolean {
  const tp = env.TERM_PROGRAM;
  if (!tp) return false;
  if (KNOWN_OSC52_TERMINALS.has(tp)) return true;
  if (tp.startsWith("tmux")) return true;
  return false;
}
