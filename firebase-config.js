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
// Firestore Collection 命名慣例（已對照 Firebase Console 實際資料校正）
// users/{uid} 綁定班級用的欄位是 classId（不是 studentClassId）
// classes/{classId}/assignments 為巢狀子集合，對應規格書 2.1 的路徑設計
// ============================================================
export const COLLECTIONS = {
  users: "users",                              // users/{uid}  -> 個人資料 (name, email, vocabGoal, avatarColorHex, authProvider...)
  vocabWords: (uid) => `users/${uid}/vocabWords`,   // 子集合：使用者的生字庫
  readHistory: (uid) => `users/${uid}/readHistory`, // 子集合：歷史閱讀足跡
  classes: "classes",                           // classes/{classId} -> 班級資料
  assignments: (classId) => `classes/${classId}/assignments`, // 子集合：班級作業
  materials: (classId) => `classes/${classId}/materials`,     // 子集合：教材庫（老師批次上傳，學生自由選讀）
  publicDictionary: "public_dictionary",        // 全域共用查詞快取 (word -> 翻譯)
  communityArticles: "community_articles",      // 新聞/文章快取
};
