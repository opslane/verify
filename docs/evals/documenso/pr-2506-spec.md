## Context
Documenso PR #2506 — Update button width to fit content on public profile page.
Template Use buttons had a hardcoded narrow width, causing text overflow with translated strings. Changed to w-fit.

## Acceptance Criteria
- On a user's public profile page, each template's "Use" button is wide enough to display its full label without truncation or overflow
- Buttons with longer translated text labels still display the full text without wrapping or cutting off
