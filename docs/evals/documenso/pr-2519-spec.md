## Context
Documenso PR #2519 — Per-recipient envelope expiration.
When sending a document for signing, each recipient can have an expiration deadline set. Once expired, the recipient sees an expiry notice page and cannot sign. The document stays PENDING for other recipients.

## Acceptance Criteria
- The document send/configure dialog shows an expiration date field for each recipient
- Setting an expiration date on a recipient shows the expiry date on the recipient's entry in the send dialog
- When viewing a document that has been sent, recipients with expiry dates show their expiry date in the document details
