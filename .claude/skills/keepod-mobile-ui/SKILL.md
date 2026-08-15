---
name: keepod-mobile-ui
description: Implement approved Keepod mobile interfaces as reusable production-quality code. Use for React Native, Expo, TypeScript, navigation, responsive layout, component architecture, forms, OCR review screens, household dashboards, assets, reminders, and assistant screens. Apply only after product structure and design-system decisions are approved.
---

# Keepod Mobile UI Engineer

## Default stack

Use React Native with Expo and TypeScript unless the repository clearly uses another approved stack.

Respect the existing package manager, lint rules, state-management approach, navigation library, API layer, and folder conventions. Do not replace architecture casually.

## Implementation workflow

1. Inspect the repository before editing.
2. Read approved UX and design-system documentation.
3. Identify reusable components and existing patterns.
4. Implement design tokens first when missing.
5. Build or extend shared components.
6. Build screens from shared components.
7. Add realistic Hebrew sample data and all required states.
8. Run type checks, lint, tests, and the app build available in the repository.
9. Capture or provide a reproducible visual-review path.

## Technical requirements

- Make Hebrew RTL the primary layout direction.
- Support Android and iOS.
- Use safe-area handling.
- Handle keyboard appearance and scrolling correctly.
- Support dynamic font sizes without clipping.
- Use typed navigation and typed data models.
- Use design tokens for color, spacing, radius, typography, and elevation.
- Avoid absolute positioning except for true overlays or deliberate layered artwork.
- Avoid fixed device-width assumptions.
- Use responsive constraints and content-driven sizing.
- Give interactive controls accessible labels and adequate touch targets.
- Preserve loading, empty, partial, error, offline, disabled, and success states.

## Shared component baseline

Use or create equivalents of:

```text
AppScreen
AppHeader
BottomNavigation
PrimaryButton
SecondaryButton
GhostButton
IconButton
InfoCard
ActionCard
StatusBadge
EmptyState
LoadingState
ErrorState
OfflineState
DocumentCard
AssetCard
ReminderCard
TaskCard
ConfirmationSheet
FormField
DateField
CurrencyField
SearchField
KeepodAssistantBubble
SourceCard
```

Do not create screen-local duplicates of reusable patterns.

## Data and AI behavior

- Keep view components independent from raw API response shapes.
- Convert API data through typed adapters or view models when needed.
- Display OCR uncertainty and allow correction.
- Preserve source filename, capture date, and related entity when relevant.
- Do not auto-execute consequential AI suggestions.
- Show source references for assistant answers that rely on household documents.

## Completion criteria

A screen is complete only when:

- it matches approved UX and design tokens
- it works in RTL
- it handles realistic long Hebrew content
- it includes all specified states
- it passes repository checks
- no avoidable duplication or hard-coded styling was introduced
- the user can navigate through the complete intended flow
