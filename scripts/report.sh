#!/usr/bin/env bash
# Render one canonical, locally served HTML report for the current run.
set -e

PLAN=".verify/plan.json"
REPORT=".verify/report.json"
PRECHECK=".verify/precheck.json"
[ -f "$PLAN" ] && [ -f "$REPORT" ] || { echo "✗ No plan/report found. Run /verify first."; exit 1; }
[ -f .verify/run-env.json ] || { echo "✗ No run environment found."; exit 1; }

esc() { jq -rn --arg s "$1" '$s | @html'; }

RUN_ID=$(jq -r '.run_id' .verify/run-env.json)
RUN_DIR=".verify/runs/$RUN_ID"
CANON="$RUN_DIR/canonical.json"
HTML="$RUN_DIR/report.html"
mkdir -p "$RUN_DIR"

# One entry per plan criterion, first matching report entry wins. Missing,
# duplicate, ghost, and invalid judge entries can never alter the result set.
jq --slurpfile rep "$REPORT" '
  [ .criteria[] as $c |
    ([$rep[0].criteria[]? | select(.ac_id == $c.id
        and (.status | IN("pass","fail","not_proven","could_not_verify")))][0]
     // {ac_id: $c.id, status: "not_proven", proof_seen: false, did: "",
         observed: "", reasoning: "no result recorded for this criterion", evidence: ""})
    + {description: $c.description, guards: ($c.guards // ""),
       depends_on: ($c.depends_on // [])} ]' "$PLAN" > "$CANON"

TOTAL=$(jq 'length' "$CANON")
PROVEN=$(jq '[.[] | select(.status=="pass" and .proof_seen==true)] | length' "$CANON")
CNV=$(jq '[.[] | select(.status=="could_not_verify")] | length' "$CANON")
FAILED_IDS=$(jq -r '[.[] | select(.status=="fail") | .ac_id] | join(", ")' "$CANON")
NOTPROVEN=$(jq '[.[] | select(.status=="not_proven" or (.status=="pass" and .proof_seen!=true))] | length' "$CANON")
DOWN_PARTS=$(jq -r '[.parts // {} | to_entries[] | select(.value=="down") | .key] | join(", ")' "$PRECHECK" 2>/dev/null || echo "")
UNCHECKED=$(jq -c '.unchecked // []' "$PRECHECK" 2>/dev/null || echo "[]")

HEADLINE="$PROVEN of $TOTAL proven."
[ "$CNV" -gt 0 ] && HEADLINE="$HEADLINE $CNV couldn't run (${DOWN_PARTS:-parts down})."
[ -n "$FAILED_IDS" ] && HEADLINE="$HEADLINE Failed: $FAILED_IDS."
[ "$NOTPROVEN" -gt 0 ] && HEADLINE="$HEADLINE $NOTPROVEN not proven."
[ "$PROVEN" = "$TOTAL" ] && [ "$TOTAL" -gt 0 ] && HEADLINE="PASS — $HEADLINE"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Verify — $HEADLINE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
jq -c '.[]' "$CANON" | while IFS= read -r criterion; do
  AC_ID=$(echo "$criterion" | jq -r '.ac_id')
  STATUS=$(echo "$criterion" | jq -r '.status')
  REASON=$(echo "$criterion" | jq -r '.reasoning')
  case "$STATUS" in
    pass) echo "  ✓ $AC_ID: $REASON" ;;
    fail) echo "  ✗ $AC_ID: $REASON" ;;
    could_not_verify) echo "  ⚠ $AC_ID: could not verify — $REASON" ;;
    not_proven) echo "  ? $AC_ID: not proven — $REASON" ;;
  esac
done

cat > "$HTML" <<'EOF'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify report</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#07111f;color:#e5edf7}
body{max-width:1080px;margin:0 auto;padding:40px 24px 80px}.meta{color:#94a3b8}.banner{background:#7f1d1d;border:1px solid #ef4444;padding:14px 18px;border-radius:10px;margin-bottom:22px}.pipeline,.not-checked,.extra{background:#101c2e;border:1px solid #26364d;padding:16px 20px;border-radius:12px;margin:18px 0}.grid{display:grid;gap:16px}.card{background:#101c2e;border:1px solid #26364d;border-radius:12px;padding:20px}.card.pass{border-left:5px solid #22c55e}.card.fail{border-left:5px solid #ef4444}.card.not_proven{border-left:5px solid #f59e0b}.card.could_not_verify{border-left:5px solid #64748b}.status,.guard{display:inline-block;border-radius:999px;padding:4px 9px;margin-right:8px;font-size:.78rem;font-weight:700;background:#1e293b}.why{color:#cbd5e1}.environmental{color:#fbbf24;font-weight:700}.evidence{display:flex;gap:12px;flex-wrap:wrap;margin-top:14px}.evidence img,.evidence video{max-width:480px;width:100%;border:1px solid #334155;border-radius:8px}h1{font-size:clamp(1.8rem,4vw,3rem);line-height:1.15}h2{margin-top:28px}dt{color:#94a3b8;font-size:.8rem;text-transform:uppercase;margin-top:10px}dd{margin:3px 0 0}code{color:#bae6fd}ul{line-height:1.6}
</style>
</head>
<body>
EOF

if [ -f "$RUN_DIR/clean-repo-violation" ]; then
  cat >> "$HTML" <<'EOF'
<div class="banner"><strong>This run modified your working tree (a verify bug) — verdicts may not describe your code.</strong> See <code>pre-run.diff</code> vs <code>post-run.diff</code>.</div>
EOF
fi

printf '<h1>%s</h1>\n' "$(esc "$HEADLINE")" >> "$HTML"
printf '<p class="meta">Run %s</p>\n' "$(esc "$RUN_ID")" >> "$HTML"
if [ -n "$DOWN_PARTS" ]; then
  printf '<section class="pipeline"><h2>Pipeline checks</h2>' >> "$HTML"
  printf '<p>Parts down: <strong>%s</strong>. Dependent checks could not run.</p>' "$(esc "$DOWN_PARTS")" >> "$HTML"
  printf '</section>' >> "$HTML"
fi
printf '<section class="grid">\n' >> "$HTML"

while IFS= read -r criterion; do
  AC_ID=$(echo "$criterion" | jq -r '.ac_id')
  STATUS=$(echo "$criterion" | jq -r '.status')
  DESCRIPTION=$(echo "$criterion" | jq -r '.description // ""')
  DID=$(echo "$criterion" | jq -r '.did // ""')
  OBSERVED=$(echo "$criterion" | jq -r '.observed // ""')
  REASON=$(echo "$criterion" | jq -r '.reasoning // ""')
  GUARDS=$(echo "$criterion" | jq -r '.guards // ""')
  case "$STATUS" in
    could_not_verify) STATUS_LABEL="could not run" ;;
    not_proven) STATUS_LABEL="not proven" ;;
    *) STATUS_LABEL="$STATUS" ;;
  esac
  case "$GUARDS" in
    new-behavior) GUARD_LABEL="proves the new behavior" ;;
    existing-behavior) GUARD_LABEL="guards existing behavior" ;;
    *) GUARD_LABEL="guard type not recorded" ;;
  esac
  printf '<article class="card %s"><div><span class="status">%s</span><span class="guard">%s</span></div>' \
    "$(esc "$STATUS")" "$(esc "$STATUS_LABEL")" "$(esc "$GUARD_LABEL")" >> "$HTML"
  printf '<h2>%s: %s</h2><dl>' "$(esc "$AC_ID")" "$(esc "$DESCRIPTION")" >> "$HTML"
  printf '<dt>Did</dt><dd>%s</dd><dt>Observed</dt><dd>%s</dd><dt>Reasoning</dt><dd>%s</dd></dl>' \
    "$(esc "${DID:-Not recorded.}")" "$(esc "${OBSERVED:-Not recorded.}")" "$(esc "${REASON:-Not recorded.}")" >> "$HTML"
  if echo "$criterion" | jq -e --argjson unchecked "$UNCHECKED" \
    '. as $c | ($c.status == "fail") and any($c.depends_on[]?; . as $p | ($unchecked | index($p)) != null)' > /dev/null; then
    printf '<p class="environmental">This failure may be environmental because a required part was not probed.</p>' >> "$HTML"
  fi
  printf '<div class="evidence">' >> "$HTML"
  EVIDENCE_DIR="$RUN_DIR/evidence/$AC_ID"
  if [ -d "$EVIDENCE_DIR" ]; then
    while IFS= read -r shot; do
      [ -n "$shot" ] || continue
      REL=${shot#"$RUN_DIR/"}
      printf '<img src="%s" alt="Screenshot evidence for %s">' "$(esc "$REL")" "$(esc "$AC_ID")" >> "$HTML"
    done < <(find "$EVIDENCE_DIR" -maxdepth 1 -type f -name 'screenshot-*.png' -print 2>/dev/null | sort)
    if [ -f "$EVIDENCE_DIR/session.webm" ]; then
      printf '<video controls src="evidence/%s/session.webm" aria-label="Video evidence for %s"></video>' \
        "$(esc "$AC_ID")" "$(esc "$AC_ID")" >> "$HTML"
    fi
  fi
  printf '</div></article>\n' >> "$HTML"
done < <(jq -c '.[]' "$CANON")
printf '</section>\n' >> "$HTML"

printf '<section class="not-checked"><h2>Not checked</h2><ul>' >> "$HTML"
NOTHING=1
while IFS= read -r part; do
  [ -n "$part" ] || continue
  printf '<li>%s had no configured probe.</li>' "$(esc "$part")" >> "$HTML"
  NOTHING=0
done < <(echo "$UNCHECKED" | jq -r '.[]?')
while IFS= read -r skipped; do
  [ -n "$skipped" ] || continue
  printf '<li>%s</li>' "$(esc "$skipped")" >> "$HTML"
  NOTHING=0
done < <(jq -r '.skipped[]?' "$PLAN")
while IFS= read -r missing; do
  [ -n "$missing" ] || continue
  printf '<li>%s has no accepted proof recorder.</li>' "$(esc "$missing")" >> "$HTML"
  NOTHING=0
done < <(jq -r '.[] | select(.status=="not_proven" or (.status=="pass" and .proof_seen!=true)) | .ac_id' "$CANON")
[ "$NOTHING" = "1" ] && printf '<li>Nothing.</li>' >> "$HTML"
printf '</ul></section>\n' >> "$HTML"

if [ -f .verify/compare.json ]; then
  printf '<section class="extra"><h2>Compare against base</h2><ul>' >> "$HTML"
  while IFS= read -r item; do
    LINE=$(echo "$item" | jq -r '"\(.id): candidate=\(.candidate), base=\(.base) — \(.reading)"')
    printf '<li>%s</li>' "$(esc "$LINE")" >> "$HTML"
  done < <(jq -c '.results[]?' .verify/compare.json)
  printf '</ul></section>\n' >> "$HTML"
fi

if [ -f .verify/review.json ]; then
  REVIEWER=$(jq -r '.reviewer // "unavailable"' .verify/review.json)
  printf '<section class="extra"><h2>Second opinion</h2><p>Reviewer: %s</p>' "$(esc "$REVIEWER")" >> "$HTML"
  if [ "$REVIEWER" = "unavailable" ]; then
    printf '<div class="banner">No second opinion was available; the criteria were reviewed only by the model that wrote them.</div>' >> "$HTML"
  fi
  printf '<ul>' >> "$HTML"
  while IFS= read -r item; do
    LINE=$(echo "$item" | jq -r '"\(.id): \(.keep) — \(.why)"')
    printf '<li>%s</li>' "$(esc "$LINE")" >> "$HTML"
  done < <(jq -c '.criteria[]?' .verify/review.json)
  while IFS= read -r missing; do
    [ -n "$missing" ] && printf '<li>Missing: %s</li>' "$(esc "$missing")" >> "$HTML"
  done < <(jq -r '.missing[]?' .verify/review.json)
  printf '</ul></section>\n' >> "$HTML"
fi

cat >> "$HTML" <<'EOF'
<section class="extra"><h2>Permanent tests</h2>
<!-- codify-block-begin -->
<p class="why">Codify suggestions appear here after the run's closing turn.</p>
<!-- codify-block-end -->
</section>
</body>
</html>
EOF

echo "  → $HTML generated"
