// ============================================================
// Firebase Service Layer (ES Module)
// 這支檔案把所有 Firebase 呼叫包裝成函式掛在 window.FB 底下，
// 讓 index.html 裡的主程式（非 module script）可以直接呼叫。
// 尚未填入真實 firebaseConfig 前，isFirebaseConfigured 為 false，
// 所有函式會直接回傳 null / 不做事，主程式會自動退回示範模式。
// ============================================================
import { firebaseConfig, isFirebaseConfigured, COLLECTIONS } from './firebase-config.js';

window.FB = { ready: false, configured: isFirebaseConfigured, user: null };

if (isFirebaseConfigured) {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js');
  const { getAnalytics, isSupported: analyticsSupported } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-analytics.js');
  const {
    getAuth, onAuthStateChanged, signInWithEmailAndPassword,
    createUserWithEmailAndPassword, signOut
  } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js');
  const {
    getFirestore, doc, getDoc, setDoc, updateDoc, deleteDoc,
    collection, addDoc, onSnapshot, query, orderBy, serverTimestamp
  } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js');
  const {
    getFunctions, httpsCallable
  } = await import('https://www.gstatic.com/firebasejs/10.14.1/firebase-functions.js');

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, 'asia-east1');
  // Analytics 只在瀏覽器支援且非 iOS PWA 獨立視窗的隱私限制情境下才會啟用，失敗不影響其他功能
  analyticsSupported().then((ok) => { if (ok) { try { getAnalytics(app); } catch (e) {} } }).catch(() => {});

  // Deterministic doc-id key for vocabWords/readHistory, mirroring the Android app's own
  // slugifyKey() (VocabViewModel.kt) so the same account's data converges onto the same doc
  // regardless of which app touches a word/article first - vocabWords/readHistory are now
  // shared between both apps rather than split into Android-only "android*" collections.
  const slugifyKey = (text) => {
    const slug = String(text || '').trim().toLowerCase()
      .replace(/[^a-z0-9一-鿿]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (slug) return slug.slice(0, 150);
    let h = 0;
    for (let i = 0; i < String(text || '').length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
    return 'w_' + Math.abs(h);
  };

  // ---- Auth ----
  window.FB.onAuthChange = (callback) => onAuthStateChanged(auth, (user) => {
    window.FB.user = user;
    callback(user);
  });

  window.FB.signIn = (email, password) =>
    signInWithEmailAndPassword(auth, email, password).then((r) => r.user);

  window.FB.signUp = async (email, password, name) => {
    const r = await createUserWithEmailAndPassword(auth, email, password);
    await setDoc(doc(db, COLLECTIONS.users, r.user.uid), {
      name, email, vocabGoal: 30, vocabLevel: "PENDING",
      authProvider: "PASSWORD", avatarColorHex: "#4285F4",
      totalUsageTimeSeconds: 0, createdAt: serverTimestamp()
    });
    return r.user;
  };

  window.FB.signOutUser = () => signOut(auth);

  // ---- User profile ----
  window.FB.getUserProfile = async (uid) => {
    const snap = await getDoc(doc(db, COLLECTIONS.users, uid));
    return snap.exists() ? { uid, ...snap.data() } : null;
  };
  window.FB.updateUserProfile = (uid, data) =>
    updateDoc(doc(db, COLLECTIONS.users, uid), data);

  // ---- Vocab words ----
  window.FB.listenVocabWords = (uid, cb) =>
    onSnapshot(collection(db, COLLECTIONS.vocabWords(uid)), (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  // Doc id = slugifyKey(word) so a word created by either app lands on the same doc (see
  // slugifyKey comment above) instead of a random addDoc() id that the other app can't predict.
  window.FB.addVocabWord = (uid, wordData) =>
    setDoc(doc(db, COLLECTIONS.vocabWords(uid), slugifyKey(wordData.word)), { ...wordData, createdAt: serverTimestamp() }, { merge: true })
      .then(() => ({ id: slugifyKey(wordData.word) }));
  window.FB.updateVocabWord = (uid, wordId, data) =>
    updateDoc(doc(db, COLLECTIONS.vocabWords(uid), wordId), data);
  window.FB.deleteVocabWord = (uid, wordId) =>
    deleteDoc(doc(db, COLLECTIONS.vocabWords(uid), wordId));

  // ---- Read history ----
  // Also doubles as Android's per-article reading-progress store (content/lastReadPage) now that
  // the two apps share this collection - doc id = slugifyKey(title), upserted with field-level
  // merge so re-opening the same article updates the timestamps without clobbering a lastReadPage
  // the Android app may have set for that same title, and without creating a duplicate entry.
  // Ordering stays on createdAt (kept fresh on every upsert below) rather than switching to
  // lastReadTime, so history entries written before this field existed don't vanish from the
  // list - Firestore's orderBy silently excludes documents missing the sorted field entirely.
  window.FB.listenReadHistory = (uid, cb) =>
    onSnapshot(query(collection(db, COLLECTIONS.readHistory(uid)), orderBy('createdAt', 'desc')), (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  window.FB.addReadHistory = (uid, article) =>
    setDoc(doc(db, COLLECTIONS.readHistory(uid), slugifyKey(article.title)), { ...article, lastReadTime: Date.now(), createdAt: serverTimestamp() }, { merge: true });
  window.FB.deleteReadHistory = (uid, id) =>
    deleteDoc(doc(db, COLLECTIONS.readHistory(uid), id));

  // ---- Class / Assignments (B2B 核心) ----
  window.FB.joinClass = async (uid, classId) => {
    const classSnap = await getDoc(doc(db, COLLECTIONS.classes, classId));
    if (!classSnap.exists()) return { success: false, message: "找不到此班級代碼，請確認後再試一次" };
    await updateDoc(doc(db, COLLECTIONS.users, uid), { classId: classId });
    return { success: true, message: "成功加入班級！" };
  };
  window.FB.leaveClass = (uid) =>
    updateDoc(doc(db, COLLECTIONS.users, uid), { classId: null });
  window.FB.listenAssignments = (classId, cb) =>
    onSnapshot(query(collection(db, COLLECTIONS.assignments(classId)), orderBy('createdAt', 'desc')), (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });
  // 教材庫：老師批次上傳、學生自由選讀，跟 assignments 平行的另一個子集合（沒有截止日/重點單字）。
  window.FB.listenMaterials = (classId, cb) =>
    onSnapshot(query(collection(db, COLLECTIONS.materials(classId)), orderBy('createdAt', 'desc')), (snap) => {
      cb(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
    });

  // ---- Public dictionary cache (查詞先查這裡，沒有才呼叫 Gemini) ----
  window.FB.getFromPublicDictionary = async (word) => {
    const snap = await getDoc(doc(db, COLLECTIONS.publicDictionary, word.toLowerCase()));
    return snap.exists() ? snap.data() : null;
  };
  window.FB.saveToPublicDictionary = (word, detail) =>
    setDoc(doc(db, COLLECTIONS.publicDictionary, word.toLowerCase()), detail);

  // ---- Cloud Functions 代理（Gemini 查詞 / RSS+Gemini 新聞生成，金鑰只存在伺服器端）----
  // 需先部署 functions/ 目錄，見 functions/index.js 內的部署說明
  window.FB.translateWordCloud = async (word) => {
    const call = httpsCallable(functions, 'translateWord');
    const res = await call({ word });
    return res.data.detail;
  };
  // 回傳該分類「今日全部文章」陣列，每篇含 headline/overview/contentEasy/contentMedium/contentHard/sourceLink/sourceName
  // Cloud Function 內部會依序查 Firestore 共享池 → 沒有才觸發 RSS 摘要 + Gemini 生成（詳見 functions/index.js）
  window.FB.fetchNewsCloud = async (category) => {
    const call = httpsCallable(functions, 'fetchCategoryNews');
    const res = await call({ category });
    return res.data.articles;
  };

  window.FB.ready = true;
  window.dispatchEvent(new Event('firebase-ready'));
} else {
  // 尚未設定 Firebase：所有呼叫直接 no-op，主程式會偵測 window.FB.configured === false 走示範模式
  window.dispatchEvent(new Event('firebase-ready'));
}
