import fs from "node:fs/promises";
import path from "node:path";
import { diffStat, renderDiff } from "./ui.js";

export interface FileChangePreview {
  path: string;
  stat: string;
  diff: string;
  isNew: boolean;
}

/** Compute a diff preview for write/edit/multi_edit calls. Returns null for unsupported tools or errors. */
export async function previewFileChange(
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<FileChangePreview | null> {
  const p = String(args.path ?? "");
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
  let oldContent = "";
  let isNew = false;
  try {
    oldContent = await fs.readFile(abs, "utf8");
  } catch {
    isNew = true;
  }

  let newContent: string | null = null;
  if (toolName === "write_file") {
    newContent = String(args.content ?? "");
  } else if (toolName === "edit_file") {
    const oldStr = String(args.old_string ?? "");
    const newStr = String(args.new_string ?? "");
    if (!oldStr || isNew) return null;
    const idx = oldContent.indexOf(oldStr);
    if (idx === -1) return null; // handler will error
    const count = oldContent.split(oldStr).length - 1;
    if (count > 1) return null;
    newContent = oldContent.replace(oldStr, newStr);
  } else if (toolName === "multi_edit") {
    const edits = args.edits;
    if (!Array.isArray(edits) || isNew) return null;
    let content = oldContent;
    for (const e of edits) {
      const edit = e as { old_string?: unknown; new_string?: unknown };
      const oldStr = String(edit?.old_string ?? "");
      const newStr = String(edit?.new_string ?? "");
      if (!oldStr) return null;
      const idx = content.indexOf(oldStr);
      if (idx === -1) return null;
      const count = content.split(oldStr).length - 1;
      if (count > 1) return null;
      content = content.replace(oldStr, newStr);
    }
    newContent = content;
  } else {
    return null;
  }

  if (newContent === null) return null;
  const rel = path.relative(cwd, abs) || abs;
  const label = isNew ? `${rel} (new file)` : rel;
  return {
    path: rel,
    stat: diffStat(oldContent, newContent),
    diff: renderDiff(oldContent, newContent, label),
    isNew,
  };
}
