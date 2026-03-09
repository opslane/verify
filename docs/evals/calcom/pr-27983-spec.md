## Context
Cal.com PR #27983 — Fix dropdown toggle indicator sync in workflow form.
The chevron icon in workflow trigger dropdowns was not reflecting open/close state.

## Acceptance Criteria
- On the Workflows page, opening the workflow trigger dropdown rotates the chevron icon to point upward
- Closing the dropdown rotates the chevron back to point downward
- The chevron direction matches the dropdown state at all times (down = closed, up = open)
