---
name: keepod-design-system
description: Define, implement, and police the Keepod visual design system. Use for colors, typography, spacing, radii, shadows, iconography, cards, buttons, forms, status treatments, mascot usage, or when reviewing UI consistency against the warm teal-and-cream Keepod brand shown in approved references.
---

# Keepod Design System

## Brand character

Make Keepod feel trustworthy, warm, domestic, organized, calm, intelligent, and approachable.

Do not make it feel corporate, childish, noisy, overly futuristic, gamified, or like a generic banking dashboard.

## Core tokens

Use these as the starting palette unless an approved design token file in the repository overrides them:

```text
primary:        #0E4D4F
secondary:      #2F7A78
background:     #FBF8F2
surface:        #FFFFFF
accent:         #F2B24B
success:        #2E7D6B
warning:        #F0B84C
critical:       #E15D5D
text-primary:   #123F43
text-muted:     #687B7C
border:         #E6DED0
```

Use semantic names in code. Do not hard-code hex values in screen components.

## Visual language

- Use warm off-white page backgrounds.
- Use white or subtly tinted surfaces.
- Use dark teal for primary headings, primary actions, active navigation, and key icons.
- Use amber sparingly for warmth, attention, and supportive highlights.
- Use rounded cards with quiet borders and low-elevation shadows.
- Preserve generous whitespace.
- Use one coherent outline icon family.
- Avoid glossy gradients, neon effects, glassmorphism, heavy drop shadows, and random decorative colors.

## Suggested token scale

```text
spacing: 4, 8, 12, 16, 20, 24, 32, 40, 48
radius:  8, 12, 16, 20, 24, 999
border:  1px default
```

Use spacing and radius tokens; do not introduce arbitrary values without updating the token source.

## Typography

- Prefer a Hebrew-capable sans-serif such as Heebo or Rubik when already licensed and available.
- Use a compact hierarchy: display, h1, h2, h3, body, body-small, label, caption.
- Keep body text highly legible and avoid overly light weights.
- Use line heights suitable for Hebrew and mixed-direction content.
- Use bold primarily for hierarchy and action, not for every label.

## Components

Prefer shared components for:

- page shell and header
- bottom navigation
- primary, secondary, ghost, and destructive buttons
- icon button
- information, action, document, asset, task, and reminder cards
- status badges
- form fields
- confirmation sheet
- empty, loading, error, and offline states
- assistant response and source cards

Before creating a component:

1. Search for an existing implementation.
2. Extend it if the pattern is reusable.
3. Create a new shared component only when no appropriate abstraction exists.

## Mascot rules

Use the hedgehog as a guide, helper, reassurance cue, onboarding character, or success companion.

Do not:

- place it in every empty region
- use it to decorate serious errors or financial warnings
- let it compete with the primary action
- change its visual style between screens
- use multiple mascot poses without a defined purpose

## Review checklist

Reject a UI change when it introduces:

- hard-coded visual values
- a second icon style
- unapproved colors
- inconsistent radii or shadows
- dense cards with poor hierarchy
- decorative elements that reduce clarity
- a visual pattern that cannot scale across the app
