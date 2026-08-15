---
name: keepod-product-ux
description: Design and review Keepod product structure, information architecture, navigation, screen hierarchy, household-management flows, and UI states. Use for planning or changing Keepod screens, bottom navigation, dashboards, document and asset flows, reminders, tasks, expenses, warranties, repairs, or the AI assistant. Invoke before visual implementation when product behavior or screen structure is not yet approved.
---

# Keepod Product UX

## Product model

Treat Keepod as a household operations and memory system, not as a generic finance dashboard or file manager.

Model these primary entities explicitly:

- Home or household
- Asset or appliance
- Document
- Receipt or invoice
- Warranty
- Repair or maintenance event
- Task
- Reminder
- Expense
- Household member
- AI-assisted answer or proposed action

Connect captured information to a relevant entity whenever possible. A receipt should not remain an isolated file when it can belong to an asset, expense, warranty, repair, or reminder.

## Required workflow

Before implementation:

1. Inspect the existing repository, routes, components, data models, and approved product documentation.
2. Identify the user goal, entry point, happy path, alternate paths, and failure paths.
3. Produce or update:
   - information architecture
   - screen inventory
   - navigation map
   - user flow
   - state matrix
   - acceptance criteria
4. Identify unresolved product decisions and assumptions.
5. Stop before coding when the requested flow is not yet approved.

## Navigation rules

- Use a five-item bottom navigation only when each destination is top-level and frequently used.
- Keep the primary order RTL-native. The rightmost destination is the default home entry.
- Recommended top-level destinations:
  - בית
  - נכסים
  - הוספה
  - פעילות
  - שאלו את קיפוד
- Keep the central add action visually prominent, but do not make it ambiguous. After tapping, show explicit actions such as צילום חשבונית, העלאת מסמך, הוספת משימה, הוספת נכס.
- Do not bury urgent actions under analytics or decorative content.

## Home-screen hierarchy

Prioritize, in order:

1. Items requiring action now
2. Upcoming deadlines and recurring obligations
3. Quick capture or add action
4. Household status summary
5. Recent activity
6. Suggestions from Keepod

Avoid presenting metrics that do not help the user decide or act.

## Flow rules

- Require one clear primary action per screen.
- Minimize mandatory fields during capture; allow later enrichment.
- Show extracted OCR data for confirmation before creating records.
- Preserve source documents and expose their provenance.
- Require confirmation for destructive, financial, irreversible, or externally visible actions.
- AI may recommend or prefill; the user confirms consequential actions.
- Never fabricate missing document fields. Mark uncertainty explicitly.

## Required states

For every screen and component define, where relevant:

- initial
- loading
- empty
- partial data
- success
- validation error
- recoverable system error
- offline
- permission denied
- destructive confirmation
- AI confidence or source state

## Output format

For design tasks, return:

1. Goal and assumptions
2. Navigation impact
3. Screen inventory
4. Main flow
5. Alternate and error flows
6. State matrix
7. Acceptance criteria
8. Open questions

Do not write production UI code until the UX structure is approved.
