---
name: keepod-hebrew-rtl
description: Review and correct Hebrew-first RTL behavior in Keepod. Use whenever building or reviewing layout direction, navigation, arrows, mixed Hebrew-English strings, dates, currency, serial numbers, filenames, forms, charts, animations, truncation, or accessibility in Hebrew interfaces.
---

# Keepod Hebrew RTL Specialist

## Core principle

Design natively for Hebrew. Do not treat RTL as an English screen mirrored at the end.

## Layout rules

- Place the primary reading and action flow from right to left.
- Put the default home destination at the right edge of bottom navigation.
- Mirror directional arrows, progress movement, drawers, and back navigation when semantics require it.
- Do not mirror non-directional symbols, brand marks, media controls, checkmarks, or technical diagrams without a semantic reason.
- Keep labels close to the control they describe.

## Mixed-direction content

Handle these explicitly:

- currency values
- dates and times
- phone numbers
- emails
- URLs
- filenames
- model numbers
- invoice numbers
- device IDs and serial numbers
- English product names inside Hebrew sentences

Use platform bidi support or explicit direction wrappers where required. Do not solve bidi issues by inserting random spaces or changing content.

Recommended currency presentation:

```text
1,240 ₪
```

Use a single approved date format throughout the product.

## Typography and truncation

- Test realistic long Hebrew titles and labels.
- Avoid narrow cards that create one-word lines.
- Prefer wrapping important text over silent truncation.
- When truncation is required, preserve the most identifying part of filenames and IDs.
- Verify line height and vertical centering with the actual chosen Hebrew font.

## Forms

- Align Hebrew labels and helper text to the right.
- Keep numeric-only inputs directionally stable.
- Keep email, URL, filename, and serial inputs readable LTR where appropriate.
- Ensure validation messages identify the field and a corrective action.
- Verify keyboard type, next-field order, and focus movement.

## Motion

Make transitions semantically consistent with RTL navigation. A screen entered by drilling deeper should move in the inverse direction of returning. Do not mirror decorative motion unless it implies direction.

## Required test matrix

Before approval test:

- short and long Hebrew text
- Hebrew plus English brand names
- large and negative currency values
- dates and times
- filenames and invoice numbers
- multiline errors
- 200% font scaling where supported
- narrow and wide phones
- Android and iOS
- screen-reader labels and order
