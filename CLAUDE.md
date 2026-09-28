# Vocabrush 專案交接筆記

給接手這個專案的 Claude Code 看的背景資料。這份筆記涵蓋到 2026-09-26 為止的開發狀態，
動手改之前務必重新讀一次實際程式碼確認現況（尤其是 firestore.rules 的實際部署版本），
不要直接假設筆記寫的還沒變。

> 這份檔案同時複製一份在 Vocabrush-PWA 跟 Vocabrush-B2B 兩個 repo 裡（各自根目錄），
> 內容應該完全一致——之後更新時記得兩邊都要改，或至少事後同步一次。

## 一句話說明專案

「刷單字、讀時事」英語學習 App，B2B 賣給補習班（不是 C2C 對學生賣）。核心流程：
老師建班 → 發班級代碼給學生 → 學生輸入代碼加入班級 → 老師發布作業或批次上傳教材庫 →
學生刷單字／讀文章，系統即時解釋生字。

## 兩個 Repo

| Repo | 本機路徑 | 角色 | 技術棧 |
|---|---|---|---|
| Vocabrush-PWA | `Vocabrush-PWA/` | 學生端(`index.html`) + 老師後台(`admin.html`) + 座位帳號管理(`seat-admin.html`)，跨平台(Android/iOS/桌機瀏覽器皆可安裝) | 純前端 HTML/JS + Firebase Auth(email/password) + Firestore + Cloud Functions(`functions/index.js`) |
| Vocabrush-B2B | `Vocabrush-B2B/` | 學生端 Android App，無老師介面 | Kotlin + Jetpack Compose + Room(本機快取) + Firebase |

兩邊共用同一個 Firebase 專案 `vocabrush-d67b3`。**Firestore 規則只有一份雲端版本**，
兩個 repo 都各自放一份 `firestore.rules` 副本，但**只有 Vocabrush-PWA 的 `firebase.json` 真正接了
`"firestore": {"rules": "firestore.rules"}`**——只有從 PWA repo 跑 `firebase deploy` 才會真的生效，
B2B 那份純粹是文件用途，改動時兩邊要同步、但部署以 PWA 為準。

## 部署方式

```bash
# PWA（改完前端檔案後）
cd Vocabrush-PWA && firebase deploy --only hosting

# Firestore 規則（改完 firestore.rules 後，一定要在 PWA repo 跑）
cd Vocabrush-PWA && firebase deploy --only firestore:rules

# Android：push 到 GitHub 後 GitHub Actions 會自動編譯 debug APK
# （.github/workflows/build-apk.yml，用 upload-artifact，需要登入 GitHub 才能下載，
#   還沒有換成更方便的 GitHub Release 下載方式——見下方「尚未決定的事」）
```

## 目前的資料架構

- `users/{uid}` — 個人資料，`role` 欄位空字串/`student`/`teacher`/`admin`。**自行註冊只能拿到
  預設角色，`teacher`/`admin` 必須手動去 Firebase Console 標記，規則刻意擋死自我升級。**
- `users/{uid}/vocabWords`、`users/{uid}/readHistory` — **兩個 App 共用**（2026-09-23 從各自獨立的
  `androidVocabWords`/`androidReadingProgress` 合併過來，同一帳號換裝置/換 App 資料是連續的）。
  doc id 是 `slugifyKey(word或title)`（trim+小寫，不能再加字元過濾，否則片語會跟單字撞 key）。
- `classes/{classId}` — 班級主檔，老師發第一篇作業/教材時順手建立，**沒有任何機制檢查代碼是否
  跟其他補習班撞名**（見下方風險）。
  - `classes/{classId}/assignments` — 老師一次發一篇的作業（有截止日、重點單字高亮）
  - `classes/{classId}/materials` — 老師批次上傳的教材庫（2026-09-25 新功能，無截止日/無重點單字，
    依「單元」分組，學生自由選讀；admin.html 用 mammoth.js 在瀏覽器端解析 .docx，不用後端）
- `public_dictionary/{word}` — 全域共用字典快取，兩個 App 查單字都先查這裡、沒有才打 Gemini。
  2026-09-16 灌了約 39,000 筆 ECDICT 常用字（含詞形變化）進去省 AI 費用。
- `community_articles` — 全域共用新聞文章快取。

## 尚未解決、下一個接手的人應該優先看的風險

1. **【重要】跨補習班資料隔離漏洞**：`firestore.rules` 的 `isClassMember(classId)` 函式裡，
   只要 `role == 'teacher'` 就對「任何」classId 放行讀寫，不限自己的班級。單一補習班測試階段
   看不出問題，但真的談了多間補習班、每間各自有老師帳號後，A 補習班的老師技術上可以讀寫
   B 補習班的作業/教材。**建議修法**：`classes/{classId}` 記錄 `ownerUid`，規則改成檢查
   `resource.data.ownerUid == request.auth.uid`（`admin` 角色保留全域存取做客服/巡查用）。
2. **班級代碼沒有強制全域唯一**——兩間補習班的老師若剛好選了同樣的代碼（Android 端甚至內建
   "CLASS101"/"VOCAB2026" 這種測試用建議代碼），資料會靜默混在一起。上面那條 ownerUid 修法
   順便能讓這個情況從「靜默混資料」變成「寫入被拒絕」，不會無聲出事。
3. **Android CI 下載體驗待決**：目前 GitHub Actions 編譯完是 `upload-artifact`，要登入 GitHub、
   下載 zip、解壓縮才能裝，不是「打開網頁就能下載」。之前提過改成 GitHub Release 直接給
   `.apk` 下載連結會更方便，但發現 B2B repo 自己的 `firebase.json` 也設定了 Hosting、
   跟 PWA 用同一個站台——如果哪天有人在 B2B repo 跑 `firebase deploy --only hosting`，
   會把正式的 PWA 網站整個蓋掉換成 B2B 的 APK 下載頁。使用者說要自己想清楚要怎麼處理這個
   衝突再決定，**目前還沒定案，不要在沒有處理這個衝突的情況下貿然幫 B2B 接 Hosting 部署**。
4. **PWA vs Android 功能對齊**：PWA 這邊 2026-09-26 剛補上真正的拖曳刷字/片語手勢（原本只有
   點字查詢），邏輯上已經跟 Android 對齊。但兩邊是各自獨立實作（PWA 純手勢偵測、Android 是
   Compose `pointerInput`），未來新功能請記得兩邊都要做，這是這個專案從一開始就反覆踩到的坑
   （複習邏輯、單字庫分組、雲端同步都各自遲早長出不一致的 bug，是雙平台架構的固定稅金）。
5. **老師帳號升級是手動流程**：新增補習班/新老師時，記得要手動去 Firebase Console 把對應
   `users/{uid}.role` 改成 `teacher`，沒有自助流程。

## 這個團隊的工作習慣／偏好（給 Claude 看）

- 每次改完都要求實際 commit + push + deploy，不是紙上談兵；重大改動（資料庫遷移、規則變更）
  習慣先口頭確認設計方向，再動手做，做完會要求證據（測試結果、live 驗證）而不只是「應該可以」。
- 發現既有 bug／風險時，會期待被明確指出來，不是含糊帶過。
- 商業考量（面向多間補習班、後端統一派帳號、成本控制）跟技術考量並重，會直接問「這樣安全/划算嗎」。
