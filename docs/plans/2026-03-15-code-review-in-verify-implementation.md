# Code Review in /verify — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an AC-aware code review stage to the /verify pipeline that runs parallel to browser agents and feeds findings into the judge as a separate track.

**Architecture:** New `code-review.sh` stage captures git diff, sends it with ACs to Opus for review, writes structured findings to `.verify/code-review.json`. The judge reads this file (if present) and includes a `code_review` field per AC in its output. Report displays both tracks side-by-side.

**Tech Stack:** Bash 3, `claude -p`, `jq`, existing pipeline infrastructure.

**Design doc:** `docs/plans/2026-03-15-code-review-in-verify.md`

---

### Task 1: Create code review prompt template

**Files:**
- Create: `scripts/prompts/code-review.txt`

**Step 1: Write the prompt file**

```text
You are a code reviewer analyzing changes against acceptance criteria.

ACCEPTANCE CRITERIA:
{{ACS}}

GIT DIFF (against base branch):
{{DIFF_STAT}}

{{DIFF}}

Review the diff and return ONLY a valid JSON object. No markdown fences, no explanation. Raw JSON only. The FIRST character of your response must be `{`.

Tasks:
1. For each finding, tag it with the AC it relates to (or "general" if it doesn't map to a specific AC).
2. Classify severity: blocker (must fix before merge) | should_fix (fix before or soon after merge) | consider (optional improvement).
3. Classify category: correctness | security | edge_case | coverage_gap | simplicity.
4. For each AC, assess whether the diff fully implements it or has gaps the browser test might not catch.

Schema:
{
  "findings": [
    {
      "ac_id": "<ac-id or general>",
      "severity": "blocker|should_fix|consider",
      "category": "correctness|security|edge_case|coverage_gap|simplicity",
      "file": "<path/to/file>",
      "line": <line number>,
      "finding": "<what's wrong — one sentence>",
      "suggestion": "<how to fix — one sentence>"
    }
  ],
  "ac_coverage": [
    {
      "ac_id": "<ac-id>",
      "implemented": true,
      "gaps": ["<description of gap, if any>"]
    }
  ]
}

Rules:
1. Only review code in the diff — do not flag pre-existing issues.
2. Be strict on coverage gaps — if an AC mentions a condition (role, state, flag), the code must handle it.
3. "general" findings are code quality issues not tied to a specific AC (security, error handling, etc).
4. Empty findings array is valid — not every diff has problems.
5. ac_coverage must have one entry per AC provided above.
6. If the diff is truncated, note that coverage assessment may be incomplete in the gaps field.
```

**Step 2: Verify the file exists**

Run: `cat scripts/prompts/code-review.txt | head -5`
Expected: First 5 lines of the prompt

**Step 3: Commit**

```bash
git add scripts/prompts/code-review.txt
git commit -m "feat(verify): add code review prompt template"
```

---

### Task 2: Create code-review.sh stage script

**Files:**
- Create: `scripts/code-review.sh`

**Depends on:** Task 1

**Step 1: Write the script**

```bash
#!/usr/bin/env bash
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE="${CLAUDE_BIN:-claude}"

if [ "${VERIFY_ALLOW_DANGEROUS:-0}" != "1" ]; then
  echo "✗ This script runs claude with --dangerously-skip-permissions."
  echo "  Set VERIFY_ALLOW_DANGEROUS=1 to proceed."
  exit 1
fi

[ -f ".verify/plan.json" ] || { echo "✗ .verify/plan.json not found"; exit 1; }

MODEL="${VERIFY_CODE_REVIEW_MODEL:-opus}"
echo "→ Running Code Review ($MODEL)..."

# ── Diff base detection ───────────────────────────────────────────────────────
# Priority: env var > config.json > auto-detect
DIFF_BASE="${VERIFY_DIFF_BASE:-$(jq -r '.diffBase // empty' .verify/config.json 2>/dev/null || echo "")}"

if [ -z "$DIFF_BASE" ]; then
  if git rev-parse --verify main >/dev/null 2>&1; then
    DIFF_BASE="main"
  elif git rev-parse --verify master >/dev/null 2>&1; then
    DIFF_BASE="master"
  else
    DIFF_BASE="HEAD~1"
  fi
fi
echo "  Diff base: $DIFF_BASE"

# ── Capture diff ──────────────────────────────────────────────────────────────
# Exclude binary files, lockfiles, and common non-code assets
DIFF_EXCLUDES="-- . ':!*.png' ':!*.jpg' ':!*.jpeg' ':!*.gif' ':!*.webm' ':!*.webp' ':!*.ico' ':!*.woff' ':!*.woff2' ':!*.ttf' ':!*.eot' ':!*.svg' ':!package-lock.json' ':!yarn.lock' ':!pnpm-lock.yaml'"

DIFF_STAT=$(eval git diff --stat "$DIFF_BASE"...HEAD $DIFF_EXCLUDES 2>/dev/null || echo "No diff stats available")

FULL_DIFF=$(eval git diff --no-ext-diff "$DIFF_BASE"...HEAD $DIFF_EXCLUDES 2>/dev/null || echo "")

if [ -z "$FULL_DIFF" ]; then
  echo "  No code changes found against $DIFF_BASE"
  # Write empty result — not an error, just nothing to review
  echo '{"findings":[],"ac_coverage":[]}' | jq '.' > .verify/code-review.json
  echo "✓ Code review complete: no changes to review"
  exit 0
fi

# ── Diff size check ───────────────────────────────────────────────────────────
MAX_LINES="${VERIFY_DIFF_MAX_LINES:-8000}"
LINE_COUNT=$(echo "$FULL_DIFF" | wc -l | tr -d ' ')
TRUNCATED=""

if [ "$LINE_COUNT" -gt "$MAX_LINES" ]; then
  echo "  ⚠ Diff is $LINE_COUNT lines — truncating to $MAX_LINES"
  FULL_DIFF=$(echo "$FULL_DIFF" | head -"$MAX_LINES")
  TRUNCATED="NOTE: Diff truncated at $MAX_LINES lines (original: $LINE_COUNT lines). Coverage assessment may be incomplete for files not shown."
fi

echo "  Diff size: $LINE_COUNT lines"

# ── Extract ACs ───────────────────────────────────────────────────────────────
ACS=$(jq -r '.criteria[] | "- \(.id): \(.description)"' .verify/plan.json)

# ── Build prompt ──────────────────────────────────────────────────────────────
PROMPT_FILE=".verify/code-review-prompt.txt"
{
  # Read template and substitute placeholders
  sed "s/{{ACS}}/$ACS_PLACEHOLDER/" "$SCRIPT_DIR/prompts/code-review.txt" | head -0
  # Safer: just build the prompt by concatenation
  cat "$SCRIPT_DIR/prompts/code-review.txt"
  printf "\n\n---\nACCEPTANCE CRITERIA:\n%s\n" "$ACS"
  printf "\nGIT DIFF STAT:\n%s\n" "$DIFF_STAT"
  printf "\nGIT DIFF:\n\`\`\`diff\n%s\n\`\`\`\n" "$FULL_DIFF"
  if [ -n "$TRUNCATED" ]; then
    printf "\n%s\n" "$TRUNCATED"
  fi
} > "$PROMPT_FILE"

# ── Call Claude ───────────────────────────────────────────────────────────────
RAW=$("$CLAUDE" -p \
  --model "$MODEL" \
  --dangerously-skip-permissions \
  < "$PROMPT_FILE" 2>/dev/null)

# Strip markdown fences if model ignores the instruction
REVIEW_JSON=$(echo "$RAW" | sed '/^```/d' | tr -d '\r')

# Validate JSON
if ! echo "$REVIEW_JSON" | jq . > /dev/null 2>&1; then
  echo "✗ Code review returned invalid JSON:"
  echo "$REVIEW_JSON" | head -20
  exit 1
fi

echo "$REVIEW_JSON" | jq '.' > .verify/code-review.json

FINDING_COUNT=$(jq '.findings | length' .verify/code-review.json)
BLOCKER_COUNT=$(jq '[.findings[] | select(.severity == "blocker")] | length' .verify/code-review.json)
echo "✓ Code review complete: $FINDING_COUNT findings ($BLOCKER_COUNT blockers)"
```

**Important:** The prompt template has `{{ACS}}`, `{{DIFF_STAT}}`, `{{DIFF}}` placeholders in the template text. But since these are multi-line values with special characters, the script does NOT use sed substitution. Instead it appends the template first (which contains the instructions and schema), then appends the actual AC list and diff as separate sections below. The `{{...}}` markers in the template serve as documentation for what will follow — same pattern as `planner.sh` which concatenates the spec after the template.

**Step 2: Make executable**

Run: `chmod +x scripts/code-review.sh`

**Step 3: Verify syntax**

Run: `bash -n scripts/code-review.sh`
Expected: No output (valid syntax)

**Step 4: Commit**

```bash
git add scripts/code-review.sh
git commit -m "feat(verify): add code-review.sh stage script"
```

---

### Task 3: Create test for code-review.sh

**Files:**
- Create: `tests/test_code-review.sh`

**Depends on:** Task 2

**Step 1: Write the test**

Follow the pattern from `tests/test_judge.sh` — mock the `claude` binary, set up fixtures, run the script, assert output.

```bash
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"

# ── Setup ─────────────────────────────────────────────────────────────────────
mkdir -p .verify

echo '{"criteria":[{"id":"ac1","description":"Header sticky on scroll","url":"/","steps":[],"screenshot_at":["after_scroll"]},{"id":"ac2","description":"Mobile nav hamburger","url":"/","steps":[],"screenshot_at":["initial"]}],"skipped":[]}' > .verify/plan.json

# Mock claude binary — returns valid code review JSON
MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat << 'JSON'
{"findings":[{"ac_id":"ac1","severity":"should_fix","category":"edge_case","file":"src/Header.tsx","line":15,"finding":"Scroll handler missing throttle","suggestion":"Add requestAnimationFrame throttle"},{"ac_id":"general","severity":"consider","category":"simplicity","file":"src/Nav.tsx","line":42,"finding":"Redundant null check","suggestion":"Remove — value is always defined here"}],"ac_coverage":[{"ac_id":"ac1","implemented":true,"gaps":[]},{"ac_id":"ac2","implemented":true,"gaps":["Only checks window.innerWidth < 768, spec says 'mobile' which could include tablets"]}]}
JSON
MOCK
chmod +x "$MOCK_CLAUDE"

# ── Test: valid run ───────────────────────────────────────────────────────────
CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_ALLOW_DANGEROUS=1 "$SCRIPT_DIR/code-review.sh" 2>/dev/null

[ -f ".verify/code-review.json" ] || { echo "FAIL: code-review.json not created"; exit 1; }

FINDING_COUNT=$(jq '.findings | length' .verify/code-review.json)
[ "$FINDING_COUNT" = "2" ] || { echo "FAIL: expected 2 findings, got $FINDING_COUNT"; exit 1; }

COVERAGE_COUNT=$(jq '.ac_coverage | length' .verify/code-review.json)
[ "$COVERAGE_COUNT" = "2" ] || { echo "FAIL: expected 2 ac_coverage entries, got $COVERAGE_COUNT"; exit 1; }

# ── Test: empty diff produces empty result ────────────────────────────────────
# Override VERIFY_DIFF_BASE to a ref that has no diff against HEAD
CLAUDE_BIN="$MOCK_CLAUDE" VERIFY_ALLOW_DANGEROUS=1 VERIFY_DIFF_BASE="HEAD" "$SCRIPT_DIR/code-review.sh" 2>/dev/null

EMPTY_FINDINGS=$(jq '.findings | length' .verify/code-review.json)
[ "$EMPTY_FINDINGS" = "0" ] || { echo "FAIL: expected 0 findings for empty diff, got $EMPTY_FINDINGS"; exit 1; }

echo "PASS: code-review tests"
rm -f "$MOCK_CLAUDE"
```

**Step 2: Run the test**

Run: `bash tests/test_code-review.sh`
Expected: `PASS: code-review tests`

**Step 3: Commit**

```bash
git add tests/test_code-review.sh
git commit -m "test(verify): add code-review.sh tests"
```

---

### Task 4: Update judge prompt for code review track

**Files:**
- Modify: `scripts/prompts/judge.txt`

**Depends on:** Task 1

**Step 1: Read current judge prompt**

Run: `cat scripts/prompts/judge.txt`
(Already captured above — 30 lines)

**Step 2: Edit the prompt**

Replace the entire contents of `scripts/prompts/judge.txt` with:

```text
You are a quality judge reviewing frontend verification results. Screenshots are embedded below as base64 images.

For each acceptance criterion, review the evidence (screenshot + agent log) and return a verdict.

CODE REVIEW FINDINGS (if present below) are a SEPARATE TRACK. Include them in the code_review field but do NOT let them override your browser-based status verdict. Browser evidence determines pass/fail. Code review is additive context.

Return ONLY a valid JSON object. No markdown fences, no explanation. Raw JSON only.

Schema:
{
  "verdict": "pass|fail|partial_pass",
  "summary": "<N>/<total> ACs passed",
  "criteria": [
    {
      "ac_id": "<id>",
      "status": "pass|fail|error|timeout",
      "reasoning": "<one sentence: what you observed in the browser>",
      "evidence": "<screenshot path>",
      "code_review": {
        "status": "clean|has_findings|unavailable",
        "findings": ["<summary of each relevant finding from code review>"],
        "coverage": "full|partial|none|unknown"
      }
    }
  ],
  "skipped": []
}

Rules:
1. Use the screenshot as primary evidence. Agent log is context.
2. pass = criterion clearly met in the screenshot
3. fail = criterion clearly not met
4. error = agent crashed or hit login redirect — cannot judge
5. timeout = agent timed out — cannot judge
6. Be strict: if you cannot clearly confirm the criterion, mark as fail.
7. If a screenshot shows a login page, mark as error: "Auth redirect".
8. code_review.status = "clean" if no findings relate to this AC.
9. code_review.status = "has_findings" if the code review found issues for this AC.
10. code_review.status = "unavailable" if no code review section is present below.
11. code_review.coverage reflects whether the code fully implements the AC per the code review's ac_coverage assessment. Use "unknown" if code review is unavailable.
12. The verdict field (pass/fail/partial_pass) is based ONLY on browser status counts. Code review findings do not change the verdict.
```

**Step 3: Verify**

Run: `wc -l scripts/prompts/judge.txt`
Expected: ~37 lines

**Step 4: Commit**

```bash
git add scripts/prompts/judge.txt
git commit -m "feat(verify): extend judge prompt with code review track"
```

---

### Task 5: Update judge.sh to read code review findings

**Files:**
- Modify: `scripts/judge.sh:58-60` (after the AC evidence loop, before the SKIPPED line)

**Depends on:** Task 4

**Step 1: Read current judge.sh**

Run: `cat scripts/judge.sh`
(Already captured above — 81 lines)

**Step 2: Add code review block after line 60**

After the line `printf "\nSKIPPED FROM PLAN: %s\n" "$SKIPPED" >> "$PROMPT_FILE"`, insert the code review section **before** that line. Specifically, between the `done` closing the AC loop (line 58) and the SKIPPED printf (line 60):

Find this block in `judge.sh`:
```bash
done

printf "\nSKIPPED FROM PLAN: %s\n" "$SKIPPED" >> "$PROMPT_FILE"
```

Replace with:
```bash
done

# ── Append code review findings (if available) ───────────────────────────────
if [ -f ".verify/code-review.json" ]; then
  printf "\n\n--- CODE REVIEW FINDINGS ---\n" >> "$PROMPT_FILE"
  cat ".verify/code-review.json" >> "$PROMPT_FILE"
  printf "\n" >> "$PROMPT_FILE"
  echo "  Including code review findings"
else
  printf "\n\n--- CODE REVIEW FINDINGS ---\nUnavailable (code review did not run or failed)\n" >> "$PROMPT_FILE"
  echo "  Code review findings not available — judge will mark as unavailable"
fi

printf "\nSKIPPED FROM PLAN: %s\n" "$SKIPPED" >> "$PROMPT_FILE"
```

**Step 3: Verify syntax**

Run: `bash -n scripts/judge.sh`
Expected: No output (valid syntax)

**Step 4: Commit**

```bash
git add scripts/judge.sh
git commit -m "feat(verify): judge reads code review findings when available"
```

---

### Task 6: Update test_judge.sh for code review fields

**Files:**
- Modify: `tests/test_judge.sh`

**Depends on:** Task 5

**Step 1: Read current test**

Run: `cat tests/test_judge.sh`
(Already captured — 25 lines)

**Step 2: Update the mock claude response to include code_review fields and add a code-review.json fixture**

Replace the entire file with:

```bash
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"

mkdir -p .verify/evidence/ac1 .verify/evidence/ac2
echo '{"criteria":[{"id":"ac1","description":"Header sticky","url":"/","steps":[],"screenshot_at":["after_scroll"]},{"id":"ac2","description":"Mobile nav","url":"/","steps":[],"screenshot_at":["initial"]}],"skipped":[]}' > .verify/plan.json
printf "VERDICT: pass\nREASONING: Header fixed\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac1/agent.log
printf "VERDICT: fail\nREASONING: Hamburger missing\nSTEPS_COMPLETED: 2/2\n" > .verify/evidence/ac2/agent.log

# Code review fixture
echo '{"findings":[{"ac_id":"ac2","severity":"blocker","category":"coverage_gap","file":"src/Nav.tsx","line":10,"finding":"Missing tablet breakpoint","suggestion":"Add 1024px check"}],"ac_coverage":[{"ac_id":"ac1","implemented":true,"gaps":[]},{"ac_id":"ac2","implemented":true,"gaps":["No tablet breakpoint"]}]}' > .verify/code-review.json

MOCK_CLAUDE=$(mktemp)
cat > "$MOCK_CLAUDE" << 'MOCK'
#!/usr/bin/env bash
cat << 'JSON'
{"verdict":"partial_pass","summary":"1/2 ACs passed","criteria":[{"ac_id":"ac1","status":"pass","reasoning":"Header confirmed fixed","evidence":".verify/evidence/ac1/agent.log","code_review":{"status":"clean","findings":[],"coverage":"full"}},{"ac_id":"ac2","status":"fail","reasoning":"Hamburger not visible","evidence":".verify/evidence/ac2/agent.log","code_review":{"status":"has_findings","findings":["Missing tablet breakpoint — blocker"],"coverage":"partial"}}],"skipped":[]}
JSON
MOCK
chmod +x "$MOCK_CLAUDE"

# ── Test: with code review ────────────────────────────────────────────────────
CLAUDE_BIN="$MOCK_CLAUDE" "$SCRIPT_DIR/judge.sh" 2>/dev/null

[ -f ".verify/report.json" ] || { echo "FAIL: report.json not created"; exit 1; }
VERDICT=$(jq -r '.verdict' .verify/report.json)
[ "$VERDICT" = "partial_pass" ] || { echo "FAIL: expected partial_pass, got $VERDICT"; exit 1; }

# Check code_review field exists
CR_STATUS=$(jq -r '.criteria[0].code_review.status' .verify/report.json)
[ "$CR_STATUS" = "clean" ] || { echo "FAIL: expected clean code_review for ac1, got $CR_STATUS"; exit 1; }

# ── Test: without code review file ────────────────────────────────────────────
rm -f .verify/code-review.json
CLAUDE_BIN="$MOCK_CLAUDE" "$SCRIPT_DIR/judge.sh" 2>/dev/null
[ -f ".verify/report.json" ] || { echo "FAIL: report.json not created (no code review)"; exit 1; }

echo "PASS: judge tests"
rm -f "$MOCK_CLAUDE"
```

**Step 3: Run the test**

Run: `bash tests/test_judge.sh`
Expected: `PASS: judge tests`

**Step 4: Commit**

```bash
git add tests/test_judge.sh
git commit -m "test(verify): update judge tests for code review track"
```

---

### Task 7: Update report.sh terminal + HTML output

**Files:**
- Modify: `scripts/report.sh`

**Depends on:** Task 5

**Step 1: Read current report.sh**

Run: `cat scripts/report.sh`
(Already captured — 152 lines)

**Step 2: Update terminal output (lines 11-22)**

Find this block in the `while IFS= read -r criterion` loop:

```bash
  case "$STATUS" in
    pass)    echo "  ✓ $AC_ID: $REASON" ;;
    fail)    echo "  ✗ $AC_ID: $REASON" ;;
    timeout) echo "  ⏱ $AC_ID: timed out" ;;
    error)   echo "  ⚠ $AC_ID: $REASON" ;;
    *)       echo "  ? $AC_ID: $STATUS — $REASON" ;;
  esac
```

Replace with:

```bash
  case "$STATUS" in
    pass)    echo "  ✓ $AC_ID: $REASON" ;;
    fail)    echo "  ✗ $AC_ID: $REASON" ;;
    timeout) echo "  ⏱ $AC_ID: timed out" ;;
    error)   echo "  ⚠ $AC_ID: $REASON" ;;
    *)       echo "  ? $AC_ID: $STATUS — $REASON" ;;
  esac
  # Code review status
  CR_STATUS=$(echo "$criterion" | jq -r '.code_review.status // "unavailable"')
  CR_FINDING_COUNT=$(echo "$criterion" | jq -r '.code_review.findings | length // 0')
  CR_COVERAGE=$(echo "$criterion" | jq -r '.code_review.coverage // "unknown"')
  case "$CR_STATUS" in
    clean)        echo "     code: clean" ;;
    has_findings) echo "     code: ⚠ $CR_FINDING_COUNT finding(s), coverage: $CR_COVERAGE" ;;
    unavailable)  echo "     code: unavailable" ;;
    *)            echo "     code: $CR_STATUS" ;;
  esac
```

**Step 3: Update HTML output (Python section)**

In the Python heredoc, add a Code Review column. Find the `rows` variable construction loop. After the `video_cell` assignment, add:

```python
    # Code review
    cr = c.get("code_review", {})
    cr_status = cr.get("status", "unavailable")
    cr_findings = cr.get("findings", [])
    cr_coverage = cr.get("coverage", "unknown")

    cr_colors = {"clean": "#22c55e", "has_findings": "#f59e0b", "unavailable": "#64748b"}
    cr_color = cr_colors.get(cr_status, "#64748b")

    if cr_status == "clean":
        cr_badge = '<span style="color:#22c55e;font-weight:600">✓ clean</span>'
    elif cr_status == "has_findings":
        cr_badge = f'<span style="color:#f59e0b;font-weight:600">⚠ {len(cr_findings)} finding(s)</span>'
        if cr_findings:
            cr_badge += '<ul style="margin:6px 0 0 0;padding-left:18px;color:#cbd5e1;font-size:0.85em">'
            for f in cr_findings:
                cr_badge += f'<li>{_html.escape(f)}</li>'
            cr_badge += '</ul>'
        if cr_coverage != "full":
            cr_badge += f'<div style="margin-top:4px;font-size:0.8em;color:#94a3b8">Coverage: {_html.escape(cr_coverage)}</div>'
    else:
        cr_badge = '<span style="color:#64748b">unavailable</span>'

    cr_cell = f'<td style="padding:12px 16px">{cr_badge}</td>'
```

Add `{cr_cell}` to the row template after `{video_cell}`, and add `<th>Code Review</th>` to the table header after `<th>Video</th>`.

**Step 4: Verify syntax**

Run: `python3 -c "compile(open('scripts/report.sh').read(), 'report.sh', 'exec')" 2>&1 || bash -n scripts/report.sh`
Expected: No errors from bash syntax check

**Step 5: Commit**

```bash
git add scripts/report.sh
git commit -m "feat(verify): add code review track to terminal + HTML report"
```

---

### Task 8: Update test_report.sh for code review output

**Files:**
- Modify: `tests/test_report.sh`

**Depends on:** Task 7

**Step 1: Read current test**

Run: `cat tests/test_report.sh`
(Already captured — 15 lines)

**Step 2: Replace with updated fixture that includes code_review fields**

```bash
#!/usr/bin/env bash
SCRIPT_DIR="$(cd "$(dirname "$0")/../scripts" && pwd)"

cat > .verify/report.json << 'JSON'
{"verdict":"partial_pass","summary":"2/3 ACs passed","criteria":[{"ac_id":"ac1","status":"pass","reasoning":"Header fixed","evidence":".verify/evidence/ac1/screenshot-after_scroll.png","code_review":{"status":"clean","findings":[],"coverage":"full"}},{"ac_id":"ac2","status":"fail","reasoning":"Hamburger missing","evidence":".verify/evidence/ac2/screenshot-initial.png","code_review":{"status":"has_findings","findings":["Missing tablet breakpoint"],"coverage":"partial"}},{"ac_id":"ac3","status":"timeout","reasoning":"Timed out","evidence":"","code_review":{"status":"unavailable","findings":[],"coverage":"unknown"}}],"skipped":["ac4: too vague"]}
JSON

output=$("$SCRIPT_DIR/report.sh" 2>&1)
echo "$output" | grep -q "✓ ac1" || { echo "FAIL: missing ✓ ac1. Output: $output"; exit 1; }
echo "$output" | grep -q "✗ ac2" || { echo "FAIL: missing ✗ ac2. Output: $output"; exit 1; }
echo "$output" | grep -q "ac3"   || { echo "FAIL: missing ac3. Output: $output"; exit 1; }
echo "$output" | grep -q "2/3"   || { echo "FAIL: missing 2/3 summary. Output: $output"; exit 1; }

# Code review lines
echo "$output" | grep -q "code: clean"        || { echo "FAIL: missing 'code: clean' for ac1. Output: $output"; exit 1; }
echo "$output" | grep -q "code: ⚠"            || { echo "FAIL: missing code review findings for ac2. Output: $output"; exit 1; }
echo "$output" | grep -q "code: unavailable"   || { echo "FAIL: missing 'code: unavailable' for ac3. Output: $output"; exit 1; }

echo "PASS: reporter tests"
```

**Step 3: Run the test**

Run: `bash tests/test_report.sh`
Expected: `PASS: reporter tests`

**Step 4: Commit**

```bash
git add tests/test_report.sh
git commit -m "test(verify): update report tests for code review track"
```

---

### Task 9: Update sync hook + SKILL.md for parallel execution

**Files:**
- Modify: `.claude/hooks/sync-skill.sh:17` (the case pattern for scripts)
- Modify: `skills/verify/SKILL.md` (Stage 2 section)

**Depends on:** Tasks 2, 7

**Step 1: Update sync hook**

In `.claude/hooks/sync-skill.sh`, find this line:

```bash
  *scripts/agent.sh|*scripts/orchestrate.sh|*scripts/preflight.sh|*scripts/planner.sh|*scripts/judge.sh|*scripts/report.sh)
```

Replace with:

```bash
  *scripts/agent.sh|*scripts/orchestrate.sh|*scripts/preflight.sh|*scripts/planner.sh|*scripts/judge.sh|*scripts/report.sh|*scripts/code-review.sh)
```

**Step 2: Update SKILL.md Stage 2**

In `skills/verify/SKILL.md`, find the Stage 2 section. Before the `rm -rf .verify/evidence` block, the code review launch should be added. After the existing orchestrate background launch, add the parallel code-review launch.

Find this block in SKILL.md:

```bash
VERIFY_ALLOW_DANGEROUS=1 bash ~/.claude/tools/verify/orchestrate.sh &
ORCH_PID=$!
```

Replace with:

```bash
VERIFY_ALLOW_DANGEROUS=1 bash ~/.claude/tools/verify/code-review.sh &
CR_PID=$!

VERIFY_ALLOW_DANGEROUS=1 bash ~/.claude/tools/verify/orchestrate.sh &
ORCH_PID=$!
```

And find the `wait $ORCH_PID` and add after it:

```bash
wait $CR_PID || true  # graceful degradation — don't fail pipeline if code review fails
```

**Step 3: Manually sync the new script**

Run: `mkdir -p ~/.claude/tools/verify && cp scripts/code-review.sh ~/.claude/tools/verify/code-review.sh`

**Step 4: Verify sync hook syntax**

Run: `bash -n .claude/hooks/sync-skill.sh`
Expected: No output

**Step 5: Commit**

```bash
git add .claude/hooks/sync-skill.sh skills/verify/SKILL.md
git commit -m "feat(verify): wire code review into pipeline and sync hook"
```

---

## Dependency Graph

```
Task 1 (prompt) ──→ Task 2 (script) ──→ Task 3 (script test)
     │                    │
     └──→ Task 4 (judge prompt) ──→ Task 5 (judge.sh) ──→ Task 6 (judge test)
                                         │
                                         └──→ Task 7 (report.sh) ──→ Task 8 (report test)
                                                    │
Task 2 ────────────────────────────────────→ Task 9 (sync + SKILL.md)
Task 7 ────────────────────────────────────→ Task 9
```

## Verification

After all tasks, run the full test suite:

```bash
for f in tests/test_*.sh; do echo "--- $f ---"; bash "$f"; done
```

Expected: All tests PASS.
