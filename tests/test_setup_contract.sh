#!/usr/bin/env bash
# The setup contract is written by an interactive skill, so the test
# validates the documented example in the skill file parses and carries
# every key the pipeline reads. Drift in the SKILL.md example breaks the build.
SKILL="$(cd "$(dirname "$0")/.." && pwd)/skills/verify-setup/SKILL.md"
EXAMPLE=$(awk '/^```json setup-contract$/,/^```$/' "$SKILL" | sed '1d;$d')
echo "$EXAMPLE" | jq . > /dev/null || { echo "FAIL: setup.json example in SKILL.md is not valid JSON"; exit 1; }
for key in mode compose_file boot teardown seed seed_data_files health_url base_url env_file observe probes; do
  echo "$EXAMPLE" | jq -e --arg k "$key" 'has($k)' > /dev/null || { echo "FAIL: example missing key $key"; exit 1; }
done
echo "$EXAMPLE" | jq -e '.probes | keys == ["sink","storage","worker"]' > /dev/null \
  || { echo "FAIL: probes must cover exactly worker/sink/storage"; exit 1; }
grep -q "sniff.sh" "$SKILL" || { echo "FAIL: skill does not run the sniffer"; exit 1; }
grep -qi "never.*credential" "$SKILL" || { echo "FAIL: skill missing the no-credentials rule"; exit 1; }
grep -q '"process"' "$SKILL" || { echo "FAIL: skill missing process mode"; exit 1; }
grep -qi "health_url.*required\|required.*health_url" "$SKILL" || { echo "FAIL: process mode must require health_url"; exit 1; }
echo "PASS: setup contract tests"
