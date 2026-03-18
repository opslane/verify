import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { AppIndex } from "./types.js";

export function loadAppIndex(verifyDir: string): AppIndex | null {
  const path = join(verifyDir, "app.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as AppIndex;
  } catch {
    return null;
  }
}

export function filterPagesByUrls(
  appIndex: AppIndex,
  urlPatterns: string[],
  limit = 10
): Record<string, AppIndex["pages"][string]> {
  if (urlPatterns.length === 0) {
    return Object.fromEntries(Object.entries(appIndex.pages).slice(0, limit));
  }

  const matched: Record<string, AppIndex["pages"][string]> = {};
  for (const [pageUrl, pageData] of Object.entries(appIndex.pages)) {
    if (urlPatterns.some((pattern) => pageUrl.startsWith(pattern))) {
      matched[pageUrl] = pageData;
    }
  }

  return Object.keys(matched).length > 0
    ? matched
    : Object.fromEntries(Object.entries(appIndex.pages).slice(0, limit));
}
