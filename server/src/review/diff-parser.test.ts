import { describe, it, expect } from "vitest";
import { parseDiff, buildLineMap } from "./diff-parser.js";
import type { DiffFile } from "./diff-parser.js";

describe("parseDiff", () => {
  it("parses a simple single-file diff", () => {
    const diff = `diff --git a/src/auth.ts b/src/auth.ts
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,4 +10,6 @@ function login() {
   existing line
+  added line 1
+  added line 2
   another existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/auth.ts");
    expect(files[0].hunks).toHaveLength(1);
    expect(files[0].hunks[0]).toEqual({
      oldStart: 10,
      oldCount: 4,
      newStart: 10,
      newCount: 6,
    });
  });

  it("parses multiple files", () => {
    const diff = `diff --git a/foo.ts b/foo.ts
--- a/foo.ts
+++ b/foo.ts
@@ -1,3 +1,4 @@
+new line
 existing
diff --git a/bar.ts b/bar.ts
--- a/bar.ts
+++ b/bar.ts
@@ -5,2 +5,3 @@
+another new line
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe("foo.ts");
    expect(files[1].path).toBe("bar.ts");
  });

  it("parses multiple hunks in one file", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
+first addition
 existing
@@ -20,3 +21,4 @@
+second addition
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].hunks).toHaveLength(2);
    expect(files[0].hunks[0].newStart).toBe(1);
    expect(files[0].hunks[1].newStart).toBe(21);
  });

  it("handles renamed files using +++ line", () => {
    const diff = `diff --git a/old-name.ts b/new-name.ts
similarity index 95%
rename from old-name.ts
rename to new-name.ts
--- a/old-name.ts
+++ b/new-name.ts
@@ -1,3 +1,4 @@
+new line
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("new-name.ts");
  });

  it("skips binary files", () => {
    const diff = `diff --git a/image.png b/image.png
Binary files a/image.png and b/image.png differ
diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
+new line
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("src/app.ts");
  });

  it("skips deleted files (+++ /dev/null)", () => {
    const diff = `diff --git a/deleted.ts b/deleted.ts
--- a/deleted.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-line 1
-line 2
-line 3
diff --git a/kept.ts b/kept.ts
--- a/kept.ts
+++ b/kept.ts
@@ -1,3 +1,4 @@
+new line
 existing
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("kept.ts");
  });

  it("handles new files (--- /dev/null)", () => {
    const diff = `diff --git a/new-file.ts b/new-file.ts
--- /dev/null
+++ b/new-file.ts
@@ -0,0 +1,5 @@
+line 1
+line 2
+line 3
+line 4
+line 5
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("new-file.ts");
    expect(files[0].hunks[0]).toEqual({
      oldStart: 0,
      oldCount: 0,
      newStart: 1,
      newCount: 5,
    });
  });

  it("ignores 'No newline at end of file' marker", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
+new line
 existing
-old line
\\ No newline at end of file
`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].hunks[0]).toEqual({
      oldStart: 1,
      oldCount: 3,
      newStart: 1,
      newCount: 4,
    });
  });

  it("returns empty array for empty diff", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("discards incomplete final hunk gracefully", () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,4 @@
+complete hunk
 existing
@@ -50,3 +51,4 @@
+this hunk is trun`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].hunks.length).toBeGreaterThanOrEqual(1);
  });
});

describe("buildLineMap", () => {
  it("builds a line map string from parsed diff files", () => {
    const files: DiffFile[] = [
      {
        path: "src/auth.ts",
        hunks: [
          { oldStart: 10, oldCount: 4, newStart: 10, newCount: 6 },
          { oldStart: 30, oldCount: 3, newStart: 32, newCount: 5 },
        ],
      },
      {
        path: "src/token.ts",
        hunks: [{ oldStart: 0, oldCount: 0, newStart: 1, newCount: 24 }],
      },
    ];
    const lineMap = buildLineMap(files);
    expect(lineMap).toContain("src/auth.ts: 10-15, 32-36");
    expect(lineMap).toContain("src/token.ts: 1-24");
  });

  it("returns empty string for empty file list", () => {
    expect(buildLineMap([])).toBe("");
  });
});
