# OpenSpec 提案資料夾慣例（CONVENTIONS）

> 這份文件是 OwnMind 內部對 OpenSpec（規格驅動開發流程）的資料夾慣例。
> OpenSpec 即「先寫一份提案 proposal、把規格 spec 跟任務 tasks 也定下來，再開始改程式」的開發流程。

本檔是政策宣告——規範**從現在起**所有 OpenSpec 提案搬遷該怎麼做。
與本檔同期、PR #37（archive 首次搬遷）會把三份已 release 的提案搬到 `archive/`、是本慣例的第一個實際案例。

---

## 1. 資料夾結構

下圖是本慣例規範的**目標結構**（`archive/` 子目錄在第一次搬遷時建立、之前不存在）：

```
openspec/
├── CONVENTIONS.md              # 本檔，OpenSpec 慣例
└── changes/                    # 所有提案都放在這裡
    ├── <version>-<topic>/      # 進行中的提案（每個版本一個資料夾）
    │   ├── proposal.md         # 提案內容：背景、動機、決策
    │   ├── spec.md             # 規格：GIVEN/WHEN/THEN 場景
    │   │                       # （白話即「前提／動作／預期結果」三段式 BDD 描述）
    │   └── tasks.md            # 任務拆解：執行清單與進度
    └── archive/                # 已 release 或棄用的提案（凍結快照）
        └── <version>-<topic>/  # 同上結構，但內容不再變動
```

說明（白話）：

- `openspec/changes/`：放**還在進行中**的提案，每個版本（例如 `v1.18.0-iron-rule-schema`）一個資料夾。
- `openspec/changes/archive/`：放**已經完工**的提案、視為歷史快照、不再改動。第一次搬遷時才會建立這個子目錄。

---

## 2. 進入 archive 的時機

提案進到 `archive/` 必須符合以下其中一個條件：

1. **該版本已正式 release**——`CHANGELOG.md` 有對應的版本條目。
2. **該提案被正式棄用**——`proposal.md` 內部有明確的棄用聲明（例如 v1.18.9 提案把 Phase 2、Phase 3 棄用，只收斂為 latency 埋點純 release）。
   - 棄用即「決定不做了」，不一定是壞掉，可能是策略改變或範圍縮小。

只要不符合上述兩個條件，就**繼續留在 `openspec/changes/` 根目錄**，不要提前搬。

---

## 3. 搬遷規則

把提案從 `changes/` 搬到 `changes/archive/` 時：

1. **一律用 `git mv`**——保留檔案歷史。
   - `git blame`（查每一行誰改的）跟 `git log --follow`（跟著 rename 一路追歷史）都要靠 git 的 rename 紀錄。
   - 不可用 `mv` 或 IDE 拖拉、那會被 git 當成「刪掉舊檔 + 新建一個檔」、丟失 rename 紀錄。
2. **資料夾正名**：如果資料夾名跟內部 `proposal.md` 標題不一致、搬遷時順手改名。
   - 例：v1.18.9 release 收斂為 latency 埋點、但資料夾名還是原先規劃的 `v1.18.5-block-feedback-and-safety-alerts`。搬遷時順手改成 `v1.18.9-mcp-latency-tracking`。
   - 正名（白話）即「把資料夾改成符合實際內容的名字」。
3. **同步檢查外部引用**：搬完之後 grep 一輪以下幾個位置、把舊路徑全部改到新路徑：
   - `CHANGELOG.md`
   - `FILELIST.md`
   - `tests/` 底下的測試與註解
   - 其他在 repo 內以絕對路徑引用該提案的檔案（例如 README、docs/）

---

## 4. archive 凍結政策

`archive/` 內部的所有檔案視為**歷史快照**：

- 內容在搬進去那一刻**就凍結**，後續不再變動。
- 即使資料夾名再次改名、或外部結構大改，**也不再追改 archive 內部檔案中的舊路徑或舊資料夾名引用**。
- 這些舊引用屬於「當時的歷史紀錄」、刻意保留，反映該提案在被定案時的真實樣貌。

**為什麼這樣做？**

如果每次外部結構變動都要回頭去改 archive 裡所有檔案，archive 就失去「歷史快照」的意義；而且這些檔案不會再被執行或讀取、只是給未來看歷史的人參考，舊路徑反而是當時時空背景的一部分。

**例外**：如果 archive 內部的引用會造成**真實的壞連結**（例如 archive 內某個檔案連到 repo 內**已被刪除**的程式碼、讀者點過去 404）、再評估是否補修。但「路徑或資料夾名字本身過期」**不算壞連結**、不必修——舊資料夾名沒人會點、只是文字紀錄。

---

## 5. 驗證流程

每次搬遷後、用以下 grep 範本確認 archive 之外**沒有殘留**舊路徑：

```bash
grep -rn "openspec/changes/<old-name>" \
  --include="*.md" --include="*.js" --include="*.json" --include="*.ts" \
  . | grep -v "archive/"
```

替換 `<old-name>` 為實際搬遷的資料夾名稱（例：`v1.17.66-windows-hardening`）。

預期輸出：**零筆**（archive 外無殘留）。

如果有命中、就把那幾處改到新路徑，再重跑一次 grep 直到歸零為止。

> 注意：grep 末段刻意 `grep -v "archive/"` 把 archive 內部的舊引用過濾掉——按第 4 條凍結政策、那些是歷史快照、不需要修。

---

## 參考紀錄

- **PR #37**（首次把已發版提案搬到 archive、定下凍結政策）：
  https://github.com/miou1107/ownmind/pull/37
- **CONVENTIONS.md 本身的成立 PR**：https://github.com/miou1107/ownmind/pull/38
  本檔以後若有修訂、在這裡持續補連結。
