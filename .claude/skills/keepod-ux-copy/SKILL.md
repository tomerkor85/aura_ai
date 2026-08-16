---
name: keepod-ux-copy
description: Write and review Hebrew UX copy for Keepod screens, buttons, onboarding, forms, empty states, OCR confirmation, reminders, tasks, errors, permissions, notifications, and AI assistant responses. Use when interface text must be concise, consistent, calm, practical, and appropriate for a household-management product.
---

# Keepod Hebrew UX Copy

## Voice

Write calm, clear, helpful, respectful Hebrew. Be warm without becoming childish, cute, salesy, or overly enthusiastic.

Prefer practical language over slogans.

## Terminology

Use these terms consistently unless product documentation defines otherwise:

- בית
- נכס
- מסמך
- חשבונית
- קבלה
- אחריות
- משימה
- תזכורת
- תיקון
- תחזוקה
- הוצאה
- פעולה נדרשת
- טיפול הושלם
- מקור
- פרטים שחולצו

Do not alternate between synonyms merely for variety.

## Action labels

Use specific verbs. Prefer:

- צילום חשבונית
- העלאת מסמך
- הוספת משימה
- הוספת נכס
- שמירת פרטים
- אישור והמשך
- סימון כטופל

Avoid a generic `הוספה` when the context can name the object or action.

## Error pattern

Every useful error should contain:

1. What could not be completed
2. What this means, when necessary
3. The next action

Example:

```text
לא הצלחנו לקרוא את החשבונית. אפשר לצלם שוב או להזין את הפרטים ידנית.
```

Avoid:

- אופס
- משהו השתבש
- raw backend messages
- blame-oriented wording
- unexplained error codes
- unnecessary exclamation marks

## AI assistant copy

- Distinguish known facts from suggestions.
- State uncertainty plainly.
- Mention the source when an answer is based on a saved document.
- Ask for confirmation before creating or changing records.
- Do not claim an action occurred before the system confirms success.

Example:

```text
לפי חשבונית הארנונה ששמרת, הסכום האחרון הוא 1,240 ₪. ליצור תזכורת לתשלום הבא?
```

## Notification copy

Lead with the required action and timing. Include the related item when space allows.

Prefer:

```text
האחריות על מכונת הכביסה מסתיימת בעוד 14 יום
```

Avoid vague alerts such as:

```text
יש לך עדכון חדש
```

## Review checklist

Check that copy is:

- understandable without product knowledge
- consistent with established terms
- short enough for mobile
- actionable
- suitable for long-text and accessibility scenarios
- free of unnecessary English when a natural Hebrew term exists
