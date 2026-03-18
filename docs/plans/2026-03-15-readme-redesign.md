# README Redesign Plan

## Context
The current README is functional but undersells the product. Redesigning to follow a narrative-first structure inspired by indie projects like gstack, claude-mem, and everything-claude-code.

## Target audience
Claude Code power users — already know the tool, want to add verification to their workflow.

## Design principles
- Lead with "why" before "how"
- Make the pain tangible with concrete examples
- Get to install in under 5 commands
- Show architecture below the fold for trust-building
- Leave room for a GIF/video upgrade later

## Structure

### 1. Hero (one-liner + hook)
- Problem/solution framing in 2-3 sentences
- No badges, no fluff — just the value prop
- Example direction: "You shipped the feature, Claude Code says it's done — but did it actually work in the browser? Verify runs a browser agent against every acceptance criterion before you push. No CI. No infrastructure."

### 2. Screenshot
- `docs/report-screenshot.png` placed immediately after the hook
- Caption: something like "A real Verify report — pass/fail per AC with screenshots and session recordings"
- Future: replace with animated GIF or video

### 3. "What it catches" section
- 3-4 realistic hypothetical examples of things that pass code review but fail in a real browser
- Short, punchy bullet points
- Examples:
  - A submit button that renders but doesn't actually POST the form
  - An auth flow that works in tests but redirects to the wrong page with real cookies
  - A modal that passes unit tests but is hidden behind a z-index in the actual browser
  - A dropdown that looks correct but doesn't respond to clicks because of an invisible overlay

### 4. Quick Start
- Prerequisites: Claude Code with OAuth, Playwright MCP
- macOS note: `brew install coreutils`
- Install: 2 commands (plugin marketplace add + plugin install)
- Setup: `/verify-setup` (one-time, skip if no login)
- Run: `/verify`
- One sentence explaining it asks for your spec upfront

### 5. How it works (pipeline)
- Mermaid diagram (keep current one)
- 5-stage breakdown with one-line descriptions:
  1. Spec Interpreter — reviews ACs for testability gaps
  2. Planner — extracts testable acceptance criteria
  3. Agents — one Claude + Playwright agent per AC
  4. Judge — reviews screenshots/traces, returns pass/fail
  5. Report — results with screenshot links and session recordings

### 6. Debugging failures
- Keep current content (trace viewer + session recording commands)
- Short and practical

### Sections NOT included (intentional)
- No badges (add later if we want)
- No "contributing" section yet
- No comparison table with other tools
- No FAQ — too early
- No architecture deep-dive beyond the diagram — link to docs/plans/ for that
