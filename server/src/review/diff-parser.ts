export interface DiffFile {
  path: string;
  hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
  }>;
}

const DIFF_HEADER_RE = /^diff --git /;
const PLUS_FILE_RE = /^\+\+\+ b\/(.+)$/;
const DEV_NULL_RE = /^\+\+\+ \/dev\/null$/;
const HUNK_RE = /^@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/;
const BINARY_RE = /^Binary files /;

/**
 * Parse a unified diff string into structured file/hunk metadata.
 * Handles renamed files, binary files, deletions, new files, and
 * truncated diffs gracefully.
 */
export function parseDiff(diff: string): DiffFile[] {
  if (!diff.trim()) return [];

  const files: DiffFile[] = [];
  const lines = diff.split("\n");

  let currentFile: DiffFile | null = null;
  let isDeleted = false;
  let isBinary = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // New file section starts
    if (DIFF_HEADER_RE.test(line)) {
      // Save previous file if valid
      if (currentFile && currentFile.hunks.length > 0) {
        files.push(currentFile);
      }
      currentFile = null;
      isDeleted = false;
      isBinary = false;
      continue;
    }

    // Binary file — skip entire section
    if (BINARY_RE.test(line)) {
      isBinary = true;
      currentFile = null;
      continue;
    }
    if (isBinary) continue;

    // Deleted file — skip (no RIGHT-side lines to comment on)
    if (DEV_NULL_RE.test(line)) {
      isDeleted = true;
      currentFile = null;
      continue;
    }
    if (isDeleted) continue;

    // Extract file path from +++ line (handles renames correctly)
    const plusMatch = line.match(PLUS_FILE_RE);
    if (plusMatch) {
      currentFile = { path: plusMatch[1], hunks: [] };
      continue;
    }

    // Parse hunk header
    if (currentFile) {
      const hunkMatch = line.match(HUNK_RE);
      if (hunkMatch) {
        currentFile.hunks.push({
          oldStart: parseInt(hunkMatch[1], 10),
          oldCount: hunkMatch[2] !== "" ? parseInt(hunkMatch[2], 10) : 1,
          newStart: parseInt(hunkMatch[3], 10),
          newCount: hunkMatch[4] !== "" ? parseInt(hunkMatch[4], 10) : 1,
        });
      }
    }
  }

  // Don't forget the last file
  if (currentFile && currentFile.hunks.length > 0) {
    files.push(currentFile);
  }

  return files;
}

/**
 * Build a human-readable line map string from parsed diff files.
 * Used in the Claude prompt so it knows which lines are commentable.
 *
 * Output format:
 *   Commentable lines:
 *   - src/auth.ts: 10-15, 32-36
 *   - src/token.ts: 1-24
 */
export function buildLineMap(files: DiffFile[]): string {
  if (files.length === 0) return "";

  const lines = files.map((file) => {
    const ranges = file.hunks.map((hunk) => {
      const end = hunk.newStart + hunk.newCount - 1;
      if (hunk.newStart === end) return `${hunk.newStart}`;
      return `${hunk.newStart}-${end}`;
    });
    return `- ${file.path}: ${ranges.join(", ")}`;
  });

  return `Commentable lines:\n${lines.join("\n")}`;
}
