const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const fetch = require("node-fetch");
const Parser = require("rss-parser");
const crypto = require("crypto");

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

// ============================================================
// B2B 補習班座位帳號批次建立（2026-09-01 建立，2026-09-02 修正）
//
// 修正說明：原本誤把 classId（老師在 App/後台自訂的班級代碼，學生要在 App
// 內「班級代碼」畫面自行輸入才會綁定）當成「補習班」本身。這裡改正為：
// 座位帳號建立時完全不寫入 classId，只用「補習班名稱」分組做座位數控管與
// 歷史查詢；學生登入這組帳號後，跟自助註冊的使用者一樣，要自己在 App 內
// 輸入老師給的班級代碼才會真正加入某個班級（既有 joinClass 流程完全不動）。
//
// 這個功能只給你（平台開發者/管理者）自己用，前端故意做成獨立的
// seat-admin.html，不跟老師共用的 admin.html 混在一起。
// Cloud Function 仍然檢查呼叫者 role==='admin'——這一步不能省略：
// 這支函式會建立真的 Firebase Auth 帳號，若沒有伺服器端權限檢查，
// 任何人只要拿到頁面網址就能狂刷帳號，直接變成你的帳單風險。
// 前端已改為單純的管理者登入（預設會記住登入狀態，不會每次都要重新輸入密碼）。
// ============================================================

const SEAT_EMAIL_DOMAIN = "seats.vocabrush.app"; // 純帳號識別用途，不需要是真的能收信的網域
const MAX_SEATS_PER_CALL = 100; // 單次呼叫上限，避免逾時；更大量需求請分批呼叫

// 避免 0/O/1/l/I 這類容易看錯的字元，方便補習班印出來給學生手動輸入
const SEAT_PASSWORD_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz";
function generateSeatPassword(length = 10) {
  const bytes = crypto.randomBytes(length);
  let pw = "";
  for (let i = 0; i < length; i++) {
    pw += SEAT_PASSWORD_ALPHABET[bytes[i] % SEAT_PASSWORD_ALPHABET.length];
  }
  return pw;
}

async function assertPlatformAdmin(request) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "請先登入");
  }
  // 對齊 firestore.rules 的雙重判斷方式：先看 auth token 的自訂 claim，沒有再查 Firestore 欄位
  if (request.auth.token && request.auth.token.role === "admin") return;
  const snap = await db.collection("users").doc(request.auth.uid).get();
  const role = snap.exists ? snap.data().role : null;
  if (role !== "admin") {
    throw new HttpsError("permission-denied", "僅限平台管理者操作此功能");
  }
}

// 找到（或建立）一間補習班的內部代碼。用「名稱字串完全相符」比對是否為同一間，
// 前端 seat-admin.html 有提供既有補習班的下拉/自動完成，降低打錯字產生重複補習班記錄的機會。
async function resolveSchool(schoolName) {
  const existing = await db.collection("schools").where("schoolName", "==", schoolName).limit(1).get();
  if (!existing.empty) {
    return { ref: existing.docs[0].ref, data: existing.docs[0].data() };
  }
  // 新補習班：用全域計數器產生短碼（S001, S002...）當 email 帳號用。
  // 補習班中文名稱不適合直接放進 email 帳號，短碼純粹是內部識別，不影響歷史查詢頁顯示的中文名稱。
  const counterRef = db.collection("meta").doc("counters");
  const schoolCode = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    const next = ((snap.exists && snap.data().schoolSeq) || 0) + 1;
    tx.set(counterRef, { schoolSeq: next }, { merge: true });
    return `S${String(next).padStart(3, "0")}`;
  });
  const ref = db.collection("schools").doc();
  const data = {
    schoolName,
    schoolCode,
    seatCounter: 0,
    totalSeatsCreated: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  await ref.set(data);
  return { ref, data };
}

// ------------------------------------------------------------
// createSchoolSeats：輸入補習班名稱＋數量，批次建立座位帳號
// 同一補習班名稱（完全相符）再次呼叫會自動延續同一間、座位編號接續不撞號。
// 輸入：{ schoolName: string, count: number }
// 輸出：{ schoolName, schoolCode, created: [{seatLabel,email,password,uid}], errors }
// ------------------------------------------------------------
exports.createSchoolSeats = onCall({ region: "asia-east1", timeoutSeconds: 120 }, async (request) => {
  await assertPlatformAdmin(request);

  const schoolName = String(request.data?.schoolName || "").trim();
  const count = Number(request.data?.count);

  if (!schoolName || schoolName.length > 100) {
    throw new HttpsError("invalid-argument", "補習班名稱不正確");
  }
  if (!Number.isInteger(count) || count < 1 || count > MAX_SEATS_PER_CALL) {
    throw new HttpsError("invalid-argument", `建立數量須為 1-${MAX_SEATS_PER_CALL} 的整數，超過請分批呼叫`);
  }

  const { ref: schoolRef, data: schoolBefore } = await resolveSchool(schoolName);
  const schoolCode = schoolBefore.schoolCode;

  // 用交易原子性地分配這批的座位編號區間，之後同一間補習班再次呼叫會自動接續
  const startIndex = await db.runTransaction(async (tx) => {
    const snap = await tx.get(schoolRef);
    const current = (snap.exists && snap.data().seatCounter) || 0;
    tx.set(
      schoolRef,
      {
        seatCounter: current + count,
        totalSeatsCreated: admin.firestore.FieldValue.increment(count),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    return current;
  });

  const created = [];
  const errors = [];

  for (let i = 0; i < count; i++) {
    const seatNo = startIndex + i + 1;
    const seatLabel = `${schoolCode}-${String(seatNo).padStart(3, "0")}`;
    const email = `${seatLabel.toLowerCase()}@${SEAT_EMAIL_DOMAIN}`;
    const password = generateSeatPassword();
    try {
      const userRecord = await admin.auth().createUser({ email, password, displayName: seatLabel });
      // 刻意不寫入 classId：classId 是老師的班級代碼，學生登入後要自己在 App 內輸入。
      await db.collection("users").doc(userRecord.uid).set({
        name: seatLabel,
        email,
        role: "student",
        vocabGoal: 30,
        vocabLevel: "PENDING",
        authProvider: "SEAT", // 跟自助註冊的 "PASSWORD" 區分，代表這是後台批次建立的座位帳號
        seatLabel,
        schoolName,
        schoolCode,
        avatarColorHex: "#4285F4",
        totalUsageTimeSeconds: 0,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      created.push({ seatLabel, email, password, uid: userRecord.uid });
    } catch (e) {
      logger.error(`建立座位帳號失敗 [${seatLabel}]`, e);
      errors.push({ seatLabel, message: e.message || "建立失敗" });
    }
  }

  // 寫入歷史紀錄，供 seat-admin.html 之後查詢（含明碼密碼——見部署指南裡的取捨說明，
  // 這個 collection 在 firestore.rules 已限制僅 role==='admin' 能讀，一般教師/學生完全看不到）。
  if (created.length > 0) {
    await db.collection("seatBatches").add({
      schoolName,
      schoolCode,
      schoolId: schoolRef.id,
      count: created.length,
      seats: created,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: request.auth.uid,
    });
  }

  return { schoolName, schoolCode, created, errors };
});

// ------------------------------------------------------------
// resetSeatPassword：重設某個座位帳號的密碼
// 合成信箱收不到 Firebase 內建的忘記密碼信，密碼遺失只能由平台管理者手動重設。
// 同步更新歷史紀錄裡對應那一筆，避免之後查歷史查到已經失效的舊密碼。
// 輸入：{ uid: string }　輸出：{ email, password }
// ------------------------------------------------------------
exports.resetSeatPassword = onCall({ region: "asia-east1" }, async (request) => {
  await assertPlatformAdmin(request);

  const uid = String(request.data?.uid || "").trim();
  if (!uid) {
    throw new HttpsError("invalid-argument", "缺少帳號 uid");
  }
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists || userSnap.data().authProvider !== "SEAT") {
    throw new HttpsError("not-found", "查無此座位帳號，或此帳號並非批次建立的座位帳號");
  }
  const newPassword = generateSeatPassword();
  await admin.auth().updateUser(uid, { password: newPassword });

  const batchQuery = await db.collection("seatBatches").where("schoolCode", "==", userSnap.data().schoolCode).get();
  for (const doc of batchQuery.docs) {
    const seats = doc.data().seats || [];
    const idx = seats.findIndex((s) => s.uid === uid);
    if (idx !== -1) {
      seats[idx] = { ...seats[idx], password: newPassword };
      await doc.ref.update({ seats });
      break;
    }
  }

  return { email: userSnap.data().email, password: newPassword };
});