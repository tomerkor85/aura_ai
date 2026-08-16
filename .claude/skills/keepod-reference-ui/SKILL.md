---
name: keepod-reference-ui
description: Analyze Keepod mockups, screenshots, presentations, or design references and translate them into a scalable production design system and implementation plan. Use when reference images are supplied, when recreating an approved visual direction, or when identifying the gap between concept slides and real mobile screens. Do not use references as raw pixel-perfect specifications without normalization.
---

# Keepod Reference-Driven UI

## Objective

Extract the reusable visual and interaction system from reference images, then adapt it to real mobile constraints. Treat references as approved direction unless the user states they are final specifications.

## Analysis workflow

Before coding:

1. Inspect every supplied reference image.
2. Identify:
   - screen purpose
   - content hierarchy
   - navigation model
   - color roles
   - typography hierarchy
   - spacing rhythm
   - card and surface patterns
   - corner radii and borders
   - icon style
   - illustration and mascot usage
   - status treatments
3. Separate reusable patterns from slide-only composition.
4. Identify inconsistencies across references.
5. Produce normalized tokens and component inventory.
6. Map each concept to responsive mobile screens and states.
7. Document deviations required for usability, accessibility, or platform behavior.
8. Stop for approval before implementation when major interpretation is required.

## Keepod-specific interpretation

Preserve these characteristics:

- dark teal and cream foundation
- warm, domestic visual tone
- white rounded cards
- thin outline icons
- restrained amber highlights
- clear Hebrew hierarchy
- calm, uncluttered layout
- hedgehog as a purposeful helper

Do not copy presentation artifacts such as oversized titles, slide framing, decorative footer waves, or dense multi-column explanation panels directly into phone screens.

## Prohibited shortcuts

Do not:

- embed screenshots as interface elements
- create one giant component matching a static image
- use arbitrary absolute positioning to imitate a slide
- invent unapproved colors or icon styles
- overuse the mascot
- omit loading, error, empty, and keyboard states
- assume desktop slide proportions represent mobile layout

## Required output

Return:

1. Reference summary
2. Stable visual principles
3. Inconsistencies and open questions
4. Proposed design tokens
5. Component inventory
6. Screen mapping
7. Responsive and RTL adaptations
8. Accessibility adaptations
9. Implementation phases
10. Items requiring approval
