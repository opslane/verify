// pipeline/src/lib/video.ts — Video file detection and renaming
import { readdirSync, renameSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Find the newest .webm file in a directory and rename it to session.webm.
 * Returns the path to session.webm, or null if no .webm files found.
 */
export function findAndRenameVideo(dir: string): string | null {
  if (!existsSync(dir)) return null;

  const webmFiles = readdirSync(dir)
    .filter(f => f.endsWith(".webm"))
    .map(f => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  if (webmFiles.length === 0) return null;

  const newest = webmFiles[0];
  const destPath = join(dir, "session.webm");
  renameSync(join(dir, newest.name), destPath);
  return destPath;
}
