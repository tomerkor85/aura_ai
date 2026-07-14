# דיפלוי AURA ל-Railway — צ'ק-ליסט

## 0. הכנה מקומית

צרו את הסיסמה המוצפנת ואת סוד הסשן, שמרו אותם בצד:

```bash
npm run hash-password -- "הסיסמה-החזקה-שלך"
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # SESSION_SECRET
```

## 1. קוד ל-GitHub

```bash
cd aura
git init                 # אם עוד לא
git add .
git commit -m "AURA"
git remote add origin https://github.com/<user>/aura.git
git branch -M main
git push -u origin main
```

> `.gitignore` כבר מונע העלאת `.env`, `node_modules`, `aura.db` — הסודות לא עולים.

## 2. פרויקט ב-Railway

1. [railway.app](https://railway.app) → התחברות עם GitHub.
2. **New Project → Deploy from GitHub repo → aura**.
3. Railway מריץ `npm start` אוטומטית (מוגדר ב-`railway.json`).

## 3. דיסק קבוע ל-DB (חובה)

Settings → **Volumes → New Volume** → Mount path: `/data`.
בלי זה כל הלקוחות נמחקים בכל דיפלוי.

## 4. משתני סביבה (Variables)

| משתנה | ערך |
|---|---|
| `DATA_DIR` | `/data` |
| `ADMIN_PASSWORD_HASH` | הפלט של hash-password (מתחיל ב-`scrypt$`) |
| `SESSION_SECRET` | המחרוזת האקראית |
| `ANTHROPIC_API_KEY` | — |
| `GREEN_API_ID_INSTANCE` | — |
| `GREEN_API_TOKEN` | — |
| `OPENAI_API_KEY` | — |
| `OPENAI_RESPONSES_MODEL` | `gpt-5.6` (לאמת בחשבון OpenAI) |
| `BYTEPLUS_API_KEY` | — |
| `SEEDREAM_MODEL` / `SEEDANCE_MODEL` | מזהי המודלים שלך |
| `TZ_NAME` | `Asia/Jerusalem` |

> אין להוסיף `ADMIN_PASSWORD` ולא `PORT` — Railway מזריק `PORT` לבד, וה-hash מחליף את הסיסמה הגלויה.

## 5. פרסום ופתיחה

1. שמירת המשתנים → Railway מדפלוי מחדש.
2. Settings → Networking → **Generate Domain** → כתובת ציבורית עם HTTPS.
3. פותחים את הכתובת → כניסה עם הסיסמה → מזינים לקוח ראשון.

## 6. ווטסאפ

עובד ב-polling — מתחיל להאזין אוטומטית כשהשירות עולה. רק לוודא שה-Instance ב-Green API
מחובר למספר (סריקת QR). אין צורך ב-webhook.

## עדכונים

```bash
git add . && git commit -m "..." && git push
```

Railway מדפלוי לבד; ה-DB על ה-Volume נשמר (הלקוחות לא נמחקים).
