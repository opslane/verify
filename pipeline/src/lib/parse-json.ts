/**
 * Parse JSON from LLM output, stripping markdown fences and surrounding text.
 * Returns null if parsing fails completely.
 *
 * The extraction strategy tries each '{' or '[' position in the string
 * rather than using a greedy regex, so "text {valid} more {other}" correctly
 * extracts {valid} instead of failing on the span between first { and last }.
 */
export function parseJsonOutput<T = unknown>(raw: string): T | null {
  if (!raw || !raw.trim()) return null;

  let text = raw.trim();

  // Strip markdown fences
  text = text.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "");

  // Try parsing the whole thing as-is
  try {
    return JSON.parse(text) as T;
  } catch {
    // Fall through to extraction
  }

  // Try parsing from each '{' or '[' position
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{" || text[i] === "[") {
      // Find matching close bracket by trying progressively larger substrings
      const closer = text[i] === "{" ? "}" : "]";
      let lastClose = text.lastIndexOf(closer);
      while (lastClose >= i) {
        try {
          const candidate = text.slice(i, lastClose + 1);
          return JSON.parse(candidate) as T;
        } catch {
          // Try a shorter substring (find previous closer)
          lastClose = text.lastIndexOf(closer, lastClose - 1);
        }
      }
    }
  }

  return null;
}
