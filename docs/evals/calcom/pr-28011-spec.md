## Context
Cal.com PR #28011 — Fix inconsistent hover width on My Account → Settings navigation.
Previously the hover highlight on VerticalTabItem used `w-fit`, making it only as wide as the text label. Changed to `w-full` so the highlight fills all available space from the indented position to the right edge of the container.

## Acceptance Criteria
- Hovering over a settings nav item (e.g. "General", "Password") shows a highlight that is clearly wider than just the text label — it should extend to the right edge of the nav container, not wrap tightly around the text
- The hover highlight width is consistent across all nav items (e.g. "General" and "Password" have the same highlight width)
