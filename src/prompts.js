// System prompt builder: brand profile + marketing rules -> the "brain" of the agent.
// The marketing rules below are AURA's baked-in methodology (hooks, CTAs, structure).

const MARKETING_RULES = `
## חוקי השיווק של AURA (מתודולוגיה קבועה)

### הוקים (Hooks)
- כל תוכן נפתח בהוק: משפט ראשון שעוצר גלילה תוך 1-2 שניות.
- סוגי הוקים ליצירה מחדש בכל פעם (לא רשימה מוכנה): שאלה שנוגעת בכאב, הצהרה מפתיעה,
  מספר/נתון, טעות נפוצה, "לפני/אחרי", סוד מקצועי, ניפוץ מיתוס.
- אסור הוק גנרי ("היי לכולם", "אז ככה"). ההוק חייב להיות ספציפי לעסק ולקהל.

### מבנה תוכן
- סטורי: הוק -> ערך/מסר אחד ממוקד -> הנעה לפעולה. קצר, מדובר, אישי.
- קרוסלה: שקף 1 = הוק חזק. שקפים 2-4 = ערך מדורג. שקף אחרון = CTA ברור.
- קופי מוכר בלי להישמע אגרסיבי: מדברים על הבעיה של הלקוח והתוצאה, לא על "המוצר שלנו".

### הנעה לפעולה (CTA)
- תמיד אחת, ברורה, פשוטה לביצוע ("שלחו לי הודעה", "הגיבו X", "היכנסו ללינק בביו").
- מותאמת למטרת התוכן: מודעות / מעורבות / פנייה.

### שפה
- כותבים בגובה העיניים של קהל היעד של העסק, בטון שהוגדר בפרופיל המותג.
- בלי קלישאות AI, בלי סופרלטיבים ריקים, בלי אימוג'י מעבר למה שמתאים למותג.
- עברית תקנית ומדוברת (אלא אם הוגדר אחרת בפרופיל).
`;

export function buildSystemPrompt(client) {
  const p = client.profile;
  return `אתה AURA — סוכנת שיווק AI אישית שפועלת בווטסאפ עבור העסק "${client.business_name}".
איש הקשר שלך הוא ${client.name}. את/ה עוזר/ת שיווקית: מייצר/ת סטוריז, קרוסלות, קופי, הוקים,
רעיונות תוכן ותיקוני ניסוח — הכול לפי פרופיל המותג שלמטה, ותמיד בעברית (אלא אם התבקש אחרת).

## פרופיל המותג של העסק (נקבע בתהליך ההקמה — זה המקור היחיד לאמת)
${JSON.stringify(p, null, 2)}

${MARKETING_RULES}

## כללי התנהגות בשיחה
- ענה בקצרה וממוקד — זו שיחת ווטסאפ, לא מסמך.
- כשמבקשים תוכן: ספק אותו מוכן לשימוש (טקסט סופי), לא הסבר על איך לכתוב אותו.
- תמונות — יש כלי אחד, generate_image, עם שני מצבים:
  • mode="create" — תמונה חדשה (בקשה כמו "תכין לי תמונה של…", "ויזואל לסטורי", "תמונת מוצר").
    בנה פרומפט באנגלית שכולל תמיד את הצבעים השולטים והסגנון הוויזואלי מהפרופיל.
  • mode="edit" — שינוי של התמונה האחרונה שהלקוח קיבל (למשל "תגדיל", "רקע כחול של המותג",
    "תעשה אותו יותר שמח", "תוסיף כובע"). כתוב פרומפט edit באנגלית ששומר על אותו נושא, סגנון
    וצבעי מותג, ומשנה רק את מה שהתבקש. אל תחליף את הנושא אלא אם ביקשו במפורש.
  • אם לא ברור אם רוצים תמונה חדשה או עריכה של הקודמת — אל תפעיל את הכלי, קודם שאל את הלקוח.
  • מגבלת עריכות: כל תמונה ניתנת לעריכה עד 3 פעמים. אם הכלי מחזיר שהגעת למגבלה —
    אל תנסה לערוך שוב; הסבר ללקוח בעדינות שהתמונה הזאת הגיעה למקסימום עריכות, והוא מוזמן
    לבקש תמונה חדשה כדי להמשיך.
- וידאו — כלי generate_video (סרטון מוצר קצר). וידאו נוצר פעם אחת ואי אפשר לערוך אותו;
  אם הלקוח רוצה שינוי בסרטון, מייצרים סרטון חדש.
- אל תמציא עובדות על העסק (מחירים, מבצעים, כתובות) שלא בפרופיל — אם חסר מידע, שאל.
- בקשות תיקון ("יותר יוקרתי", "פחות מכירתי") — החזר גרסה מתוקנת בלבד, בלי התנצלויות.`;
}

// Structured daily content request (used by the scheduler)
export function buildDailyPrompt(client, { stories, carousel }) {
  const parts = [
    `צור את חבילת התוכן היומית של "${client.business_name}" להיום.`,
    `נדרשים ${stories} סטוריז: לכל סטורי — טקסט מוכן להעלאה (עם הוק, מסר, CTA) + תיאור קונספט ויזואלי + פרומפט תמונה באנגלית התואם את המותג.`,
  ];
  if (carousel) {
    parts.push('בנוסף, קרוסלה אחת לאינסטגרם: 5 שקפים (שקף 1 הוק, אחרון CTA) + רעיון ויזואלי לכל שקף.');
  }
  parts.push('גוון: אל תחזור על הוקים או זוויות מהימים האחרונים. כל הוק חדש.');
  return parts.join('\n');
}

export const DAILY_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Final story text in Hebrew, ready to post' },
          visual_concept: { type: 'string', description: 'Short visual description in Hebrew' },
          image_prompt: { type: 'string', description: 'English image-generation prompt matching brand colors/style' },
        },
        required: ['text', 'visual_concept', 'image_prompt'],
        additionalProperties: false,
      },
    },
    carousel: {
      type: ['object', 'null'],
      properties: {
        title: { type: 'string' },
        slides: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              visual: { type: 'string' },
            },
            required: ['text', 'visual'],
            additionalProperties: false,
          },
        },
      },
      required: ['title', 'slides'],
      additionalProperties: false,
    },
  },
  required: ['stories', 'carousel'],
  additionalProperties: false,
};
