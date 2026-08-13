const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();

// ============================================================
// 金鑰存在 Secret Manager，不會出現在程式碼或前端。
// 部署前請先執行（只需做一次）：
//   firebase functions:secrets:set GEMINI_API_KEY
//   firebase functions:secrets:set NEWS_API_KEY
// 系統會提示你貼上金鑰值，之後 Functions 執行時會自動注入。
// ============================================================
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const NEWS_API_KEY = defineSecret("NEWS_API_KEY");

// ------------------------------------------------------------
// translateWord：對照原始碼 VocabDetail 查詢邏輯
// 1. 先查 Firestore public_dictionary 快取
// 2. 沒有才呼叫 Gemini API，並把結果寫回快取供全體使用者共用
// ------------------------------------------------------------
exports.translateWord = onCall({ secrets: [GEMINI_API_KEY], region: "asia-east1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "請先登入才能查詢單字");
  }
  const word = String(request.data?.word || "").trim().toLowerCase();
  if (!word || word.length > 100) {
    throw new HttpsError("invalid-argument", "單字格式不正確");
  }

  // Step 1：查快取
  const cacheRef = db.collection("public_dictionary").doc(word);
  const cacheSnap = await cacheRef.get();
  if (cacheSnap.exists) {
    return { source: "cache", detail: cacheSnap.data() };
  }

  // Step 2：呼叫 Gemini API
  const prompt = `You are a bilingual (English-Traditional Chinese) dictionary. For the English word or short phrase "${word}", respond ONLY with strict JSON (no markdown fences) in this exact shape:
{"word":"${word}","phonetic":"IPA without slashes","partOfSpeech":"adj./n./v. etc in Chinese abbreviation","translation":"Traditional Chinese meaning, short","definition":"One sentence Traditional Chinese definition"}`;

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY.value()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 300 },
      }),
    }
  );

  if (!geminiRes.ok) {
    logger.error("Gemini API error", await geminiRes.text());
    throw new HttpsError("internal", "翻譯或金鑰認證失敗");
  }

  const geminiJson = await geminiRes.json();
  const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  let detail;
  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    detail = JSON.parse(cleaned);
  } catch (e) {
    logger.error("Gemini JSON parse failed", rawText);
    throw new HttpsError("internal", "AI 回應格式錯誤，請再試一次");
  }

  // Step 3：寫回全域快取，供下一位使用者直接命中
  await cacheRef.set(detail);

  return { source: "gemini", detail };
});

// ------------------------------------------------------------
// fetchCategoryNews：對照原始碼 fetchCategoryNews 邏輯
// 呼叫 News API，並簡單快取到 community_articles（依 category + 日期）
// ------------------------------------------------------------
exports.fetchCategoryNews = onCall({ secrets: [NEWS_API_KEY], region: "asia-east1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "請先登入才能瀏覽新聞");
  }
  const category = String(request.data?.category || "general");
  const allowed = ["technology", "science", "business", "general"];
  if (!allowed.includes(category)) {
    throw new HttpsError("invalid-argument", "不支援的新聞分類");
  }

  const dateString = new Date().toISOString().slice(0, 10);
  const cacheId = `${category}_${dateString}`;
  const cacheRef = db.collection("community_articles").doc(cacheId);
  const cacheSnap = await cacheRef.get();
  if (cacheSnap.exists) {
    return { source: "cache", articles: cacheSnap.data().articles || [] };
  }

  const newsRes = await fetch(
    `https://newsapi.org/v2/top-headlines?category=${category}&language=en&pageSize=15&apiKey=${NEWS_API_KEY.value()}`
  );
  if (!newsRes.ok) {
    logger.error("News API error", await newsRes.text());
    throw new HttpsError("internal", "新聞來源暫時無法連線");
  }
  const newsJson = await newsRes.json();
  const articles = (newsJson.articles || []).map((a) => ({
    title: a.title,
    description: a.description || "",
    source: { name: a.source?.name || "即時時事" },
  }));

  await cacheRef.set({ category, dateString, articles, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

  return { source: "newsapi", articles };
});
