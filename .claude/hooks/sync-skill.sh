#!/usr/bin/env bash
# Sync skill files to ~/.claude/skills/ after any edit.
# Triggered by PostToolUse hook for Write and Edit tools.

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool_input', {}).get('file_path', ''))" 2>/dev/null)

case "$FILE_PATH" in
  *skills/verify/SKILL.md)
    mkdir -p ~/.claude/skills/verify
    cp "$FILE_PATH" ~/.claude/skills/verify/SKILL.md
    echo "synced skills/verify/SKILL.md → ~/.claude/skills/verify/SKILL.md" >&2
    ;;
esac
