# AURA — סוכנת שיווק AI אישית בווטסאפ

מערכת שמייצרת תוכן שיווקי יומי וממותג לכל לקוח דרך שיחת ווטסאפ.
סוכן אחד משותף לכל הלקוחות — הזיהוי לפי מספר הטלפון, והתוכן (טקסט, תמונות, וידאו) נוצר לפי פרופיל המותג של אותו לקוח ב-DB.

## ארכיטקטורה

```
                 ┌───────────────────────────┐
   פאנל ניהול ───►│  DB (SQLite)              │◄─── תהליך ההקמה: מזינים פרופיל מותג
   (public/UI)    │  clients / history        │
                 └────────────┬──────────────┘
                              │ זיהוי לפי מספר טלפון
   ווטסאפ (Green API) ────────►│
                              ▼
                        src/agent.js
                   ┌──────────┼───────────────┐
                   ▼          ▼                ▼
              Claude      Seedream        Seedance
             (קופי/הוקים)  (תמונות)        (וידאו)
                              │  BytePlus
   src/daily.js ──► מתזמן שעתי: תוכן יומי לפי חבילה (2/4 סטוריז, קרוסלות)
```

## רכיבים

| רכיב | תפקיד |
|---|---|
| `src/index.js` | תהליך ראשי: מאזין להודעות ווטסאפ + מריץ את המתזמן + מרים את פאנל הניהול |
| `src/admin.js` + `public/` | פאנל ניהול לקוחות (UI) — הזנת פרופיל מותג, שמירה ל-DB, "צור תוכן עכשיו" |
| `src/agent.js` | הסוכן: Claude לטקסט + כלים `generate_image` / `generate_video` |
| `src/visual.js` | מנוע ויזואל — BytePlus Seedream (תמונות) + Seedance (וידאו), OpenAI כגיבוי |
| `src/daily.js` | יצירה ושליחה של התוכן היומי לכל לקוח לפי חבילה |
| `src/greenapi.js` | שכבת ווטסאפ (שליחה, קבלה ב-polling) |

## התקנה

```bash
cd aura
npm install
copy .env.example .env    # ולמלא את המפתחות
```

מפתחות ב-`.env`:

| משתנה | מאיפה |
|---|---|
| `GREEN_API_ID_INSTANCE` + `GREEN_API_TOKEN` | Green API — Instance מחובר למספר ווטסאפ (QR) |
| `ANTHROPIC_API_KEY` | console.anthropic.com — מנוע הטקסט |
| `BYTEPLUS_API_KEY` + `SEEDREAM_MODEL` + `SEEDANCE_MODEL` | BytePlus ModelArk — תמונות ווידאו |
| `OPENAI_API_KEY` | גיבוי לתמונות (אופציונלי) |
| `ADMIN_PASSWORD_HASH` + `SESSION_SECRET` | אבטחת פאנל הניהול (ראו למטה) |

## אבטחת פאנל הניהול

מנהל יחיד (בעלת העסק) — אין חשבונות משתמשים, יש סיסמה אחת. אבל מוקשח לרשת:

- **סיסמה שמורה כ-hash** (scrypt), לא בטקסט גלוי.
- **סשן מבוסס טוקן חתום** ב-cookie מסוג `HttpOnly` + `SameSite=Strict` + `Secure` — לא נשלחת סיסמה בכל בקשה, וה-JS בדפדפן לא יכול לקרוא את הסשן.
- **הגבלת קצב** על ניסיונות כניסה (נעילה אחרי 8 כשלונות ב-10 דקות).

הגדרה לפרודקשן:

```bash
npm run hash-password -- "סיסמה-חזקה-שלך"
# מעתיקים את הפלט ל-.env:
#   ADMIN_PASSWORD_HASH=scrypt$...
# ומוחקים את שורת ADMIN_PASSWORD.
```

בנוסף, מגדירים `SESSION_SECRET` למחרוזת אקראית ארוכה (כדי שסשנים לא יתאפסו בכל restart).
בענן עם HTTPS (Railway) דגל ה-`Secure` נדלק אוטומטית; מקומית בלי HTTPS הוא כבוי כדי לאפשר בדיקה.

## הרצה

```bash
npm start     # מריץ הכל: מאזין לווטסאפ + מתזמן יומי + פאנל ניהול
```

פאנל הניהול: http://localhost:3000 (או `ADMIN_PORT`).
מזינים סיסמה (`ADMIN_PASSWORD`), מוסיפים לקוח, ממלאים את פרופיל המותג המלא, שומרים.
כפתור "צור תוכן עכשיו" מייצר ושולח מיד לווטסאפ של אותו לקוח.

בדיקות:

```bash
npm run smoke                       # בדיקת עשן בלי קריאות API
npm run admin                       # פאנל הניהול בלבד
npm run send-daily                  # שליחת תוכן יומי לכל הלקוחות עכשיו
npm run send-daily -- 972501234567  # רק ללקוח מסוים
```

## חבילות

| | סטוריז/יום | קרוסלות/שבוע | וידאו |
|---|---|---|---|
| `basic` | 2 | 1 (ראשון) | — |
| `premium` | 4 | 2 (ראשון + רביעי) | ✓ |

מוגדר ב-[src/config.js](src/config.js).

## דיפלוי לענן (Railway)

1. דוחפים את התיקייה `aura/` ל-GitHub.
2. ב-Railway: New Project → Deploy from GitHub → בוחרים את הריפו.
3. מוסיפים **Volume** וממפים ל-`/data`, ומגדירים `DATA_DIR=/data` (כדי שה-DB יישמר בין דיפלויים).
4. ממלאים את משתני הסביבה מ-`.env.example` תחת Variables.
5. Railway מריץ `npm start` אוטומטית ([railway.json](railway.json)).

הקוד לא נעול ל-Railway — אותו `npm start` ירוץ גם על VPS (Hetzner וכו') להוזלה עתידית.

## הערות

- **Polling ולא webhook** — המערכת מושכת הודעות מ-Green API, אז רצה גם ממחשב מקומי בלי כתובת ציבורית. בענן אפשר לעבור ל-webhook.
- **תמונות יומיות** — `DAILY_IMAGES=true` מצרף תמונה לכל סטורי יומי (עולה יותר). כבוי כברירת מחדל; תמונות/וידאו נוצרים לפי בקשה בצ'אט או בכפתור "צור תוכן עכשיו".
- **BytePlus** — מזהי המודלים (`SEEDREAM_MODEL` / `SEEDANCE_MODEL`) נלקחים מקונסולת BytePlus שלך. אם ה-endpoint באזור אחר, עדכני `BYTEPLUS_BASE_URL`.
- מספרים לא מוכרים (שאינם ב-DB) — המערכת מתעלמת מהם.
