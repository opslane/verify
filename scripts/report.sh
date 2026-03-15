#!/usr/bin/env bash
[ -f ".verify/report.json" ] || { echo "✗ No report found. Run /verify first."; exit 1; }

SUMMARY=$(jq -r '.summary' .verify/report.json)

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " Verify — $SUMMARY"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

jq -c '.criteria[]' .verify/report.json | while IFS= read -r criterion; do
  AC_ID=$(echo "$criterion" | jq -r '.ac_id')
  STATUS=$(echo "$criterion" | jq -r '.status')
  REASON=$(echo "$criterion" | jq -r '.reasoning')
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
done

SKIPPED_COUNT=$(jq '.skipped | length' .verify/report.json)
if [ "$SKIPPED_COUNT" -gt 0 ]; then
  echo ""
  jq -r '.skipped[]' .verify/report.json | while IFS= read -r msg; do
    echo "  ⚠ Skipped: $msg"
  done
fi

echo ""

# Debug hints for failures
jq -r '.criteria[] | select(.status=="fail") | .ac_id' .verify/report.json | while IFS= read -r AC_ID; do
  TRACE=".verify/evidence/$AC_ID/trace"
  VIDEO=".verify/evidence/$AC_ID/session.webm"
  RESULT=".verify/evidence/$AC_ID/result.json"
  [ -d "$TRACE" ] && echo "  Debug: npx playwright show-report $TRACE"
  [ -f "$VIDEO" ]  && echo "  Video: open $VIDEO"
  [ -f "$RESULT" ] && echo "  Evidence: cat $RESULT"
  ls .verify/evidence/"$AC_ID"/screenshot-*.png 2>/dev/null | while read -r img; do
    echo "  Screenshot: open $img"
  done
done

# ── Generate HTML report ───────────────────────────────────────────────────────
python3 - << 'PYEOF'
import json, os, base64, glob, pathlib, html as _html

report = json.load(open(".verify/report.json"))
summary = report.get("summary", "")
verdict = report.get("verdict", "unknown")
criteria = report.get("criteria", [])
skipped  = report.get("skipped", [])

verdict_color = {"pass": "#22c55e", "partial_pass": "#f59e0b", "fail": "#ef4444"}.get(verdict, "#94a3b8")
status_icon   = {"pass": "✓", "fail": "✗", "timeout": "⏱", "error": "⚠"}
status_color  = {"pass": "#22c55e", "fail": "#ef4444", "timeout": "#f59e0b", "error": "#f59e0b"}

def img_tag(path, label=""):
    try:
        data = base64.b64encode(open(path, "rb").read()).decode()
        label = _html.escape(label)
        return f'<img src="data:image/png;base64,{data}" alt="{label}" title="{label}" style="max-width:320px;max-height:200px;border-radius:4px;cursor:pointer;border:1px solid #334155" onclick="this.style.maxWidth=this.style.maxWidth==\'100%\'?\'320px\':\'100%\'">'
    except Exception:
        return ""

rows = ""
for c in criteria:
    ac_id   = _html.escape(c.get("ac_id", ""))
    status  = c.get("status", "unknown")
    reason  = _html.escape(c.get("reasoning", ""))
    icon    = status_icon.get(status, "?")
    color   = status_color.get(status, "#94a3b8")

    # Screenshots
    screenshots = sorted(glob.glob(f".verify/evidence/{ac_id}/screenshot-*.png"))
    imgs = "".join(img_tag(p, pathlib.Path(p).stem) for p in screenshots)
    imgs_cell = f'<div style="display:flex;flex-wrap:wrap;gap:6px">{imgs}</div>' if imgs else '<span style="color:#475569">—</span>'

    # Video — use absolute file:// path so browser can always load it
    video_path = f".verify/evidence/{ac_id}/session.webm"
    if os.path.exists(video_path):
        abs_path = pathlib.Path(video_path).resolve().as_uri()
        video_cell = (
            f'<video controls src="{abs_path}" style="max-width:320px;border-radius:4px;border:1px solid #334155" preload="metadata">'
            f'<a href="{abs_path}" style="color:#60a5fa">Download video</a>'
            f'</video>'
        )
    else:
        video_cell = '<span style="color:#475569">—</span>'

    # Code review
    cr = c.get("code_review", {})
    cr_status = cr.get("status", "unavailable")
    cr_findings = cr.get("findings", [])
    cr_coverage = cr.get("coverage", "unknown")

    if cr_status == "clean":
        cr_badge = '<span style="color:#22c55e;font-weight:600">&#10003; clean</span>'
    elif cr_status == "has_findings":
        cr_badge = f'<span style="color:#f59e0b;font-weight:600">&#9888; {len(cr_findings)} finding(s)</span>'
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

    rows += f"""
    <tr>
      <td style="padding:12px 16px;white-space:nowrap;font-weight:600;color:#e2e8f0">{ac_id}</td>
      <td style="padding:12px 16px;white-space:nowrap">
        <span style="color:{color};font-size:1.1em;font-weight:700">{icon}</span>
        <span style="color:{color};text-transform:uppercase;font-size:0.75em;font-weight:600;margin-left:4px">{status}</span>
      </td>
      <td style="padding:12px 16px;color:#cbd5e1;line-height:1.5">{reason}</td>
      <td style="padding:12px 16px">{imgs_cell}</td>
      <td style="padding:12px 16px">{video_cell}</td>
      {cr_cell}
    </tr>"""

skipped_rows = ""
for s in skipped:
    skipped_rows += f'<tr><td colspan="6" style="padding:8px 16px;color:#64748b;font-size:0.85em">⊘ {s}</td></tr>'

html = f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Verify Report</title>
<style>
  * {{ box-sizing: border-box; margin: 0; padding: 0; }}
  body {{ background: #0f172a; color: #e2e8f0; font-family: ui-monospace, 'Cascadia Code', 'Fira Code', monospace; padding: 32px; }}
  h1 {{ font-size: 1.25rem; font-weight: 700; color: #f8fafc; margin-bottom: 4px; }}
  .meta {{ color: #64748b; font-size: 0.85em; margin-bottom: 28px; }}
  .badge {{ display: inline-block; padding: 3px 10px; border-radius: 99px; font-size: 0.8em; font-weight: 700; background: {verdict_color}22; color: {verdict_color}; border: 1px solid {verdict_color}55; margin-left: 10px; vertical-align: middle; }}
  table {{ width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 8px; overflow: hidden; }}
  thead tr {{ background: #0f172a; }}
  th {{ padding: 10px 16px; text-align: left; color: #64748b; font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600; }}
  tbody tr {{ border-top: 1px solid #1e293b; }}
  tbody tr:nth-child(even) {{ background: #162032; }}
  tbody tr:hover {{ background: #1e3a5f22; }}
</style>
</head>
<body>
<h1>Verify Report <span class="badge">{verdict}</span></h1>
<p class="meta">{summary}</p>
<table>
  <thead>
    <tr>
      <th>AC</th><th>Status</th><th>Notes</th><th>Screenshots</th><th>Video</th><th>Code Review</th>
    </tr>
  </thead>
  <tbody>
    {rows}
    {skipped_rows}
  </tbody>
</table>
</body>
</html>"""

with open(".verify/report.html", "w") as f:
    f.write(html)
print("  → .verify/report.html generated")
PYEOF

# Auto-open in Chrome (supports .webm); fall back to default browser
if [ -f ".verify/report.html" ]; then
  ABS_REPORT="$(cd .verify && pwd)/report.html"
  open -a "Google Chrome" "$ABS_REPORT" 2>/dev/null || open "$ABS_REPORT" 2>/dev/null || true
fi
