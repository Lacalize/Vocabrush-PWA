const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const Parser = require("rss-parser");

admin.initializeApp();
const db = admin.firestore();
const rssParser = new Parser({ timeout: 8000 });

// ============================================================
// 金鑰存在 Secret Manager，不會出現在程式碼或前端。
// 部署前請先執行（只需做一次）：
//   firebase functions:secrets:set GEMINI_API_KEY
// 新聞功能改為「RSS 摘要 + Gemini 生成」，不再呼叫任何第三方新聞 API，
// 因此不需要 NEWS_API_KEY / GNEWS_API_KEY，也沒有新聞 API 的商業授權/配額問題。
// ============================================================
const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------
// translateWord：對照原始碼 VocabDetail 查詢邏輯（未變動）
// ------------------------------------------------------------
exports.translateWord = onCall({ secrets: [GEMINI_API_KEY], region: "asia-east1" }, async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "請先登入才能查詢單字");
  }
  const word = String(request.data?.word || "").trim().toLowerCase();
  if (!word || word.length > 100) {
    throw new HttpsError("invalid-argument", "單字格式不正確");
  }

  const cacheRef = db.collection("public_dictionary").doc(word);
  const cacheSnap = await cacheRef.get();
  if (cacheSnap.exists) {
    return { source: "cache", detail: cacheSnap.data() };
  }

  const prompt = `You are a bilingual (English-Traditional Chinese) dictionary. For the English word or short phrase "${word}", respond ONLY with strict JSON (no markdown fences) in this exact shape:
{"word":"${word}","phonetic":"IPA without slashes","partOfSpeech":"adj./n./v. etc in Chinese abbreviation","translation":"Traditional Chinese meaning, short","definition":"One sentence Traditional Chinese definition"}`;

  // 使用 gemini-3.5-flash-lite（與新聞生成同一顆模型），gemini-2.0-flash 已下架會導致 404 查詞失敗
  const translateModel = await getConfiguredModel("dictionaryModel", "gemini-3.5-flash-lite");
  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${translateModel}:generateContent?key=${GEMINI_API_KEY.value()}`,
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

  await cacheRef.set(detail);

  return { source: "gemini", detail };
});

// ============================================================
// 新聞功能：RSS 摘要 + Gemini 生成（三層快取 / Cache-Aside，逐分類觸發）
// Layer 1（用戶端 localStorage，前端 index.html 負責）：當日已載入過即 0 延遲
// Layer 2（Firestore community_articles，全用戶共用）：該分類當天已有人生成過就直接讀
// Layer 3（Gemini 即時生成，本檔負責）：當天全體用戶「首次造訪該分類」才觸發，
//          一次生成該分類 5 篇獨立文章（各含三種難度版本），全部寫回 Firestore 共享池
// ============================================================

const NEWS_CATEGORIES_ORDER = ["technology", "business", "science", "health", "entertainment"];
const ARTICLES_PER_CATEGORY = 5;

// RSS 來源：目前 5 個分類全部抓 BBC News 官方 RSS（feeds.bbci.co.uk），
// 僅取「標題 + 摘要」作為事實素材，不做全文擷取或轉載。可自行在此增列同分類的其他來源。
const RSS_SOURCES = {
  technology: ["http://feeds.bbci.co.uk/news/technology/rss.xml"],
  business: ["http://feeds.bbci.co.uk/news/business/rss.xml"],
  science: ["http://feeds.bbci.co.uk/news/science_and_environment/rss.xml"],
  health: ["http://feeds.bbci.co.uk/news/health/rss.xml"],
  entertainment: ["http://feeds.bbci.co.uk/news/entertainment_and_arts/rss.xml"],
};

function stripHtml(input) {
  return String(input || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchCategoryRss(category) {
  const feeds = RSS_SOURCES[category] || [];
  const items = [];
  for (const feedUrl of feeds) {
    try {
      const feed = await rssParser.parseURL(feedUrl);
      for (const item of (feed.items || []).slice(0, ARTICLES_PER_CATEGORY)) {
        items.push({
          title: stripHtml(item.title),
          summary: stripHtml(item.contentSnippet || item.summary || item.content || "").slice(0, 240),
          link: item.link || "",
          source: feed.title || "BBC News",
        });
      }
    } catch (e) {
      logger.error(`RSS 讀取失敗 [${category}] ${feedUrl}`, e);
    }
  }
  return items.slice(0, ARTICLES_PER_CATEGORY);
}

// 從 Firestore app_config/gemini 讀取可切換的 model 名稱，避免像 translateWord 一樣
// 因為 model 名稱寫死在程式碼裡、下架後要重新部署才能修的問題（對應舊技術債 #2）
async function getConfiguredModel(field, fallback) {
  try {
    const snap = await db.collection("app_config").doc("gemini").get();
    return (snap.exists && snap.data()?.[field]) || fallback;
  } catch (e) {
    return fallback;
  }
}

// 每個分類單獨呼叫一次 Gemini（而非把 5 大分類塞進同一次呼叫），
// 原因：(1) 對齊原始規格「該分類首次造訪才觸發」的逐分類設計，不必要地一次生成其他 4 個
//       分類會浪費 Token；(2) 25 篇文章的內容塞進單一回應容易撞到輸出長度上限、
//       導致 JSON 被截斷解析失敗（這正是先前版本「只有摘要沒有生成內文」的根因之一）。
function buildGeminiCategoryPrompt(category, items) {
  const materialJson = JSON.stringify(items.map((it) => ({ title: it.title, summary: it.summary })));
  return `You are an ESL content writer producing original English news-style articles for Taiwanese learners practicing reading.

You are given ${items.length} real news headlines and short summaries (facts only) from the "${category}" category, gathered from RSS feeds. For EACH source item, write ONE wholly original article inspired by its facts. Do NOT copy or closely paraphrase the wording or sentence structure of the source summary — rewrite entirely in your own words using only the underlying facts, names, numbers and events. Do not fabricate facts, quotes or statistics not supported by the source. Keep the same order as the source list (item 1 -> article 1, item 2 -> article 2, ...).

For each article, produce THREE versions of the SAME underlying story at different reading levels:
- contentEasy — CEFR A2-B1: short sentences, high-frequency vocabulary (top ~2000 English words), simple tenses, 150-200 words.
- contentMedium — CEFR B2: everyday and workplace vocabulary, some complex sentences, 200-250 words.
- contentHard — CEFR C1-C2: advanced academic/professional vocabulary, complex sentence structures, nuanced argumentation, 250-300 words.

Also write:
- headline: a short, captivating headline, no more than 12 words, identical across all 3 levels.
- overview: a 1-2 sentence hook in plain English (around CEFR B1), used as a preview card before the reader opens the full article.

Source material (JSON array, same order as the articles to produce):
${materialJson}

Respond ONLY with strict JSON (no markdown fences, no commentary) — an array of exactly ${items.length} objects, in source order, matching this shape:
[{"headline":"...","overview":"...","contentEasy":"...","contentMedium":"...","contentHard":"..."}]`;
}

async function generateCategoryArticles(category, items) {
  if (!items.length) return [];
  const model = await getConfiguredModel("newsModel", "gemini-3.5-flash-lite");
  const prompt = buildGeminiCategoryPrompt(category, items);

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY.value()}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // 8192：單一分類最多 5 篇 x 3 難度版本的輸出量仍有餘裕，降低被截斷導致 JSON 解析失敗的風險
        generationConfig: { temperature: 0.6, maxOutputTokens: 8192, responseMimeType: "application/json" },
      }),
    }
  );

  if (!geminiRes.ok) {
    logger.error(`Gemini 新聞生成失敗 [${category}]`, await geminiRes.text());
    throw new Error(`Gemini 新聞生成失敗（${category}）`);
  }

  const geminiJson = await geminiRes.json();
  const rawText = geminiJson?.candidates?.[0]?.content?.parts?.[0]?.text || "[]";

  let list;
  try {
    const cleaned = rawText.replace(/```json|```/g, "").trim();
    list = JSON.parse(cleaned);
  } catch (e) {
    logger.error(`Gemini 新聞 JSON 解析失敗 [${category}]`, rawText);
    throw new Error(`AI 新聞回應格式錯誤（${category}）`);
  }

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`AI 新聞回應為空（${category}）`);
  }
  for (const a of list) {
    if (!a.headline || !a.contentEasy || !a.contentMedium || !a.contentHard) {
      throw new Error(`AI 新聞回應缺少必要欄位（${category}）`);
    }
  }

  return list.map((a, i) => ({
    headline: a.headline,
    overview: a.overview || "",
    contentEasy: a.contentEasy,
    contentMedium: a.contentMedium,
    contentHard: a.contentHard,
    sourceLink: (items[i] && items[i].link) || "",
    sourceName: (items[i] && items[i].source) || "",
  }));
}

// ------------------------------------------------------------
// fetchCategoryNews：三層快取入口，逐分類生成 / 讀取
// 回傳該分類「今日全部文章」陣列（每篇含三種難度版本），供前端顯示與快取
// ------------------------------------------------------------
exports.fetchCategoryNews = onCall(
  { secrets: [GEMINI_API_KEY], region: "asia-east1", timeoutSeconds: 180, memory: "512MiB" },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "請先登入才能瀏覽新聞");
    }
    const category = String(request.data?.category || "");
    if (!NEWS_CATEGORIES_ORDER.includes(category)) {
      throw new HttpsError("invalid-argument", "不支援的新聞分類");
    }

    const dateString = new Date().toISOString().slice(0, 10);
    const cacheRef = db.collection("community_articles").doc(`${category}_${dateString}`);
    const cacheSnap = await cacheRef.get();
    if (cacheSnap.exists) {
      return { source: "cache", articles: cacheSnap.data().articles || [] };
    }

    // Layer 2 沒有今日資料 -> 嘗試搶下「該分類今日生成鎖」，避免多位使用者同時重複呼叫 Gemini
    const lockRef = db.collection("daily_generation_status").doc(`${category}_${dateString}`);
    const claimed = await db.runTransaction(async (tx) => {
      const lockSnap = await tx.get(lockRef);
      if (lockSnap.exists && lockSnap.data().status === "pending") return false;
      tx.set(lockRef, {
        status: "pending",
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
        expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + 3 * 24 * 3600 * 1000),
      });
      return true;
    });

    if (claimed) {
      try {
        const items = await fetchCategoryRss(category);
        const articles = await generateCategoryArticles(category, items);
        const expiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + 7 * 24 * 3600 * 1000);
        await cacheRef.set({
          category,
          dateString,
          articles,
          generatedBy: await getConfiguredModel("newsModel", "gemini-3.5-flash-lite"),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          expiresAt,
        });
        await lockRef.set(
          { status: "done", finishedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      } catch (e) {
        logger.error(`新聞生成失敗 [${category}]`, e);
        await lockRef.set(
          { status: "failed", finishedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
        throw new HttpsError("internal", "新聞生成失敗，請稍後再試");
      }
      const finalSnap = await cacheRef.get();
      if (!finalSnap.exists) {
        throw new HttpsError("internal", "新聞生成後寫入異常，請稍後再試");
      }
      return { source: "gemini", articles: finalSnap.data().articles || [] };
    }

    // 有其他使用者正在生成該分類：短暫輪詢等待其完成，避免重複呼叫 Gemini
    for (let i = 0; i < 8; i++) {
      await sleep(1500);
      const snap = await cacheRef.get();
      if (snap.exists) return { source: "cache", articles: snap.data().articles || [] };
    }
    throw new HttpsError("deadline-exceeded", "今日新聞生成中，請稍後再試一次");
  }
);
