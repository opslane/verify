// A file is a test if its NAME marks it as one, or if it sits in a directory
// conventionally reserved for tests. Name-only matching missed `tests/helper.ts`
// and `__tests__/fixtures.ts`, while the skill told the reader every test file
// was excluded.
const TEST_FILE = new RegExp(
  [
    String.raw`(\.|_)(test|spec)\.[cm]?[jt]sx?$`, // foo.test.ts, foo_spec.js
    String.raw`_test\.go$`,
    String.raw`(^|/)test_[^/]*\.py$`,
    String.raw`_spec\.rb$`,
    String.raw`Test\.java$`,
    String.raw`(^|/)(__tests__|__mocks__|tests?|spec)/`, // any file under a test dir
  ].join("|"),
);

/**
 * Turn `git diff --name-only` output into a list of behaviour-bearing files.
 * Test files are dropped: changing a test is not a behaviour change to verify.
 */
export function parseDiffNames(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !TEST_FILE.test(line));
}

/**
 * Which changed files no criterion claims. The claim mapping is supplied by the
 * caller and is a judgment, not a computation. Getting it wrong shows up as a
 * file listed under "No criterion covers", which is the honest failure mode.
 */
export function uncoveredFiles(
  changed: string[],
  claimedByCriterion: Record<string, string[]>,
): string[] {
  const claimed = new Set(Object.values(claimedByCriterion).flat());
  return changed.filter((file) => !claimed.has(file));
}
