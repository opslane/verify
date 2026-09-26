/** Names the verifier's own environment owns; repo data never sets them. */
export const DENYLISTED_ENV = /^(PATH|IFS|ENV|BASH_ENV|SHELL|CDPATH|LD_.*|DYLD_.*|PS4|PROMPT_COMMAND|TMPDIR)$/;

/**
 * The contract's env file, parsed exactly as scripts/env.sh and precheck.sh
 * parse it: KEY=VALUE lines only, never executed. Lines whose key is not an
 * identifier (comments, `export X=1`), keys starting with a digit, lines with
 * no `=`, and denylisted names are skipped; a value wrapped in a pair of double
 * quotes loses them. Later lines win.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    const at = line.indexOf('=');
    if (at === -1) continue;
    const key = line.slice(0, at);
    let value = line.slice(at + 1);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || DENYLISTED_ENV.test(key)) continue;
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    values[key] = value;
  }
  return values;
}
