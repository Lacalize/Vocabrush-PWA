// ============================================================
// Firebase 設定檔
// 請到 Firebase Console → 專案設定 → 一般 → 新增/選取「Web App」
// 把拿到的 firebaseConfig 物件貼在下面取代 PLACEHOLDER 的值即可，
// 其他程式碼完全不用動。
// ============================================================

export const firebaseConfig = {
  apiKey: "AIzaSyAnnD53AE7fWLy2p9Ms9JF4PqFdwl7FJ44",
  authDomain: "vocabrush-d67b3.firebaseapp.com",
  projectId: "vocabrush-d67b3",
  storageBucket: "vocabrush-d67b3.firebasestorage.app",
  messagingSenderId: "1005708387940",
  appId: "1:1005708387940:web:6708122ee0ec615f2ea171",
  measurementId: "G-8XLKRESTJM"
};

// 偵測是否已填入真實設定值（避免尚未設定時整個 App 因連線錯誤而白畫面）
export const isFirebaseConfigured = firebaseConfig.apiKey !== "YOUR_API_KEY";

// ============================================================
// Firestore Collection 命名慣例（依照你現有 Android 端程式碼推斷）
// 這份對照表是我從你提供的 firestore.rules / VocabRepository 相關程式碼
// 反推出來的，實際欄位名稱如果跟你正式資料庫不同，麻煩告訴我，我會調整。
// ============================================================
export const COLLECTIONS = {
  users: "users",                              // users/{uid}  -> 個人資料 (name, email, vocabGoal, avatarColorHex, authProvider...)
  vocabWords: (uid) => `users/${uid}/vocabWords`,   // 子集合：使用者的生字庫
  readHistory: (uid) => `users/${uid}/readHistory`, // 子集合：歷史閱讀足跡
  classes: "classes",                           // classes/{classId} -> 班級資料
  assignments: (classId) => `classes/${classId}/assignments`, // 子集合：班級作業
  publicDictionary: "public_dictionary",        // 全域共用查詞快取 (word -> 翻譯)
  communityArticles: "community_articles",      // 新聞/文章快取
};
