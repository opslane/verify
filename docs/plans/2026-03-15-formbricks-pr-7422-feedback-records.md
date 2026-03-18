# PR #7422 — Feedback Records Table

## Summary
Adds a Feedback Records page to the Unify workspace, allowing users to view, paginate, and refresh feedback records from connectors and sources.

## PR
formbricks/formbricks#7422

## Acceptance Criteria

1. The Unify config navigation shows a "Feedback Records" tab that links to the feedback records page
2. The Feedback Records page renders a table with columns for field types, values, and locale-formatted dates
3. Boolean values in the table display translated "Yes"/"No" text (not raw true/false)
4. Long cell values show a tooltip on hover with the full text
5. The "Refresh" button reloads records and shows a toast notification
6. The "Load more" button at the bottom of the table appends additional paginated records
7. When no records exist, an empty state message is displayed

## Test Context
- URL: /environments/{environmentId}/workspace/unify/feedback-records
- Requires: logged-in user with org owner/manager role or project team read access
- Base branch: epic/connectors (not main)
