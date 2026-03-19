#!/usr/bin/env bash
# Sync skills/verify/SKILL.md to ~/.claude/skills/verify/SKILL.md after any edit.
# Triggered by PostToolUse hook for Write and Edit tools.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input', {}).get('file_path', ''))" 2>/dev/null)

case "$FILE_PATH" in
  *skills/verify/SKILL.md)
    cp "$FILE_PATH" ~/.claude/skills/verify/SKILL.md
    echo "synced skills/verify/SKILL.md → ~/.claude/skills/verify/SKILL.md" >&2
    ;;
  *skills/verify-setup/SKILL.md)
    cp "$FILE_PATH" ~/.claude/skills/verify-setup/SKILL.md
    echo "synced skills/verify-setup/SKILL.md → ~/.claude/skills/verify-setup/SKILL.md" >&2
    ;;
  *scripts/agent.sh|*scripts/orchestrate.sh|*scripts/preflight.sh|*scripts/planner.sh|*scripts/judge.sh|*scripts/report.sh|*scripts/code-review.sh|*scripts/install-browse.sh)
    SCRIPT_NAME=$(basename "$FILE_PATH")
    mkdir -p ~/.claude/tools/verify
    cp "$FILE_PATH" ~/.claude/tools/verify/"$SCRIPT_NAME"
    echo "synced $SCRIPT_NAME → ~/.claude/tools/verify/$SCRIPT_NAME" >&2
    ;;
  *scripts/prompts/*.txt)
    PROMPT_NAME=$(basename "$FILE_PATH")
    mkdir -p ~/.claude/tools/verify/prompts
    cp "$FILE_PATH" ~/.claude/tools/verify/prompts/"$PROMPT_NAME"
    echo "synced prompts/$PROMPT_NAME → ~/.claude/tools/verify/prompts/$PROMPT_NAME" >&2
    ;;
  *pipeline/src/*|*pipeline/package.json|*pipeline/tsconfig.json|*pipeline/vitest.config.ts)
    REPO_ROOT=$(cd "$(dirname "$FILE_PATH")" && git rev-parse --show-toplevel 2>/dev/null)
    if [ -n "$REPO_ROOT" ] && [ -d "$REPO_ROOT/pipeline" ]; then
      mkdir -p ~/.claude/tools/verify/pipeline
      rsync -a --delete "$REPO_ROOT/pipeline/" ~/.claude/tools/verify/pipeline/
      echo "synced pipeline/ → ~/.claude/tools/verify/pipeline/" >&2
    fi
    ;;
esac
