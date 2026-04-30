import type { CommandSuggestion, SessionState } from "./session.js";
import { errorLine, infoLine, successLine } from "./ui.js";
import { copyToClipboard, likelySupportsOsc52 } from "./clipboard.js";

export type PickResult =
  | { ok: true; suggestion: CommandSuggestion }
  | { ok: false; message: string };

/** Resolve the user's `[n]` argument against the current session's suggestions. */
export function pickSuggestion(session: SessionState, arg: string | undefined): PickResult {
  const suggestions: CommandSuggestion[] = session.suggestions ?? [];
  if (suggestions.length === 0) {
    return { ok: false, message: "no commands to run from the last reply" };
  }
  let n = 1;
  if (arg !== undefined && arg !== "") {
    if (!/^\d+$/.test(arg)) {
      return { ok: false, message: `invalid suggestion id: ${arg} (expected positive integer)` };
    }
    n = Number(arg);
    if (n <= 0) {
      return { ok: false, message: `invalid suggestion id: ${arg} (expected positive integer)` };
    }
  }
  const found = suggestions.find((s) => s.id === n);
  if (!found) {
    const max = suggestions.length;
    return { ok: false, message: `no suggestion with id ${n} (have: 1..${max})` };
  }
  return { ok: true, suggestion: found };
}

export interface RunDeps {
  runShell: (command: string) => Promise<void>;
  log: (line: string) => void;
}

export interface InsertDeps {
  setPendingInitial: (text: string) => void;
  log: (line: string) => void;
}

export interface CopyDeps {
  log: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  copy?: (text: string) => void;
}

export async function handleRun(session: SessionState, arg: string | undefined, deps: RunDeps): Promise<void> {
  const pick = pickSuggestion(session, arg);
  if (!pick.ok) {
    deps.log(errorLine(pick.message));
    return;
  }
  const { suggestion } = pick;
  deps.log(infoLine(`▶  running suggestion ${suggestion.id}`));
  await deps.runShell(suggestion.code);
}

export function handleInsert(session: SessionState, arg: string | undefined, deps: InsertDeps): void {
  const pick = pickSuggestion(session, arg);
  if (!pick.ok) {
    deps.log(errorLine(pick.message));
    return;
  }
  const { suggestion } = pick;
  deps.setPendingInitial(suggestion.code);
  deps.log(infoLine(`✏  ready to edit at next prompt — press Enter to send, Esc to cancel`));
}

export function handleCopy(session: SessionState, arg: string | undefined, deps: CopyDeps): void {
  const pick = pickSuggestion(session, arg);
  if (!pick.ok) {
    deps.log(errorLine(pick.message));
    return;
  }
  const { suggestion } = pick;
  const copy = deps.copy ?? copyToClipboard;
  copy(suggestion.code);
  deps.log(successLine(`copied suggestion ${suggestion.id} to clipboard (${suggestion.code.length} chars)`));
  if (!likelySupportsOsc52(deps.env ?? process.env)) {
    deps.log(infoLine("hint: if nothing was copied, your terminal may not support OSC 52 — use /insert n then ctrl+c instead"));
  }
}
