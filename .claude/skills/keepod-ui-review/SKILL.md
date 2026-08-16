---
name: keepod-ui-review
description: Perform final UX, visual, RTL, accessibility, responsive, and state-completeness review of Keepod mobile UI. Use before declaring a screen or flow complete, during pull-request review, after visual changes, or when comparing implementation to approved references and design-system rules.
---

# Keepod UI Quality Review

## Principle

Do not consider a screen complete merely because it compiles or resembles the reference at one viewport.

## Review workflow

1. Read the approved UX, design tokens, and reference analysis.
2. Inspect the implementation and shared components.
3. Run available checks and launch the app.
4. Test the complete flow, not only isolated screens.
5. Compare screenshots at representative phone sizes.
6. Record issues by severity and cite the relevant component or file.
7. Do not silently redesign approved behavior during review.

## Severity

- **Blocker:** prevents task completion, causes data loss, exposes wrong data, or creates an inaccessible critical flow.
- **Major:** substantial visual, RTL, state, or interaction mismatch.
- **Minor:** localized inconsistency with limited task impact.
- **Polish:** non-blocking refinement.

## Visual checks

Verify:

- hierarchy
- alignment
- spacing
- typography
- color semantics
- borders and shadows
- radii
- icon family and size
- mascot purpose and scale
- component reuse
- absence of hard-coded visual drift

## Functional and state checks

Verify:

- navigation order
- primary action clarity
- input and keyboard behavior
- loading
- empty
- partial data
- error and retry
- offline
- disabled
- success
- permissions
- destructive confirmations
- OCR correction
- AI source and confirmation behavior

## RTL and content checks

Test:

- long Hebrew headings
- mixed Hebrew-English strings
- dates
- currency
- filenames and IDs
- multiline errors
- truncation
- back arrows and transitions
- bottom navigation ordering

## Accessibility checks

Verify:

- touch targets
- contrast
- accessible names and roles
- screen-reader order
- dynamic type
- focus handling
- color is not the only status indicator

## Required report format

```text
Summary
Blockers
Major issues
Minor issues
Polish
Verified states and devices
Unverified areas
Recommended next action
```

Include concrete reproduction steps and expected behavior for every blocker or major issue.
