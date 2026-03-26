---
name: brainstorm_before_coding
description: User wants to brainstorm/discuss before any code changes, especially for architectural problems like auth reliability
type: feedback
---

Don't jump straight to coding fixes. When the user shares a problem analysis or debugging session, they want to discuss and brainstorm the approach first before any code is written.

**Why:** The user explicitly asked to brainstorm auth reliability issues rather than have code changes made immediately. Architectural problems need discussion before implementation.

**How to apply:** When the user shares a problem diagnosis or asks "why is X broken", default to discussion mode. Ask questions, explore alternatives, and wait for agreement before touching code.
