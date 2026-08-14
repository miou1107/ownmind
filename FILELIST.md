# OwnMind 檔案結構

## v1.26.173 修改（一次觸發只佔一行，不要再被主程式蓋三次章）

修改：
```
hooks/ownmind-tty-echo.cjs                      — formatBlock 改單行輸出：事件用 ┃ 串接
                                                   （分隔符抽成 EVENT_SEPARATOR 常數）。
                                                   extractBanners 比對前先把 \r／U+2028／
                                                   U+2029／U+000B／U+0085 換成空白，修掉
                                                   「訊息整則消失」與「字元溜進輸出」。
                                                   新增 stripLabelColon()：只有整行僅一個
                                                   冒號時才拿掉尾端冒號。
tests/ownmind-tty-echo.test.js                  — 合併測試改測單行契約（無換行、簽章只有
                                                   一行開頭符合）；新增換行字元測試，樣本
                                                   內文真的帶那些字元，斷言訊息沒少、字元
                                                   沒溜出去（拿掉修正會紅）。
shared/update-banner.js                         — 待送佇列改用 logs/update-pending.jsonl
                                                   （原本混在稽核檔裡）；新增
                                                   updateQueuePath()、readUpdateNotices()、
                                                   clearDeliveredUpdateNotices()（按行數
                                                   刪，不整檔清）；開頭說明改寫，不再宣稱
                                                   開場會補送。
hooks/ownmind-reply-lint.js                     — 送達點：解析 payload 後立刻把待送的更新
                                                   結果排進使用者訊息；stdout 真的寫出去
                                                   之後才清佇列。
hooks/lib/pending-banners.js                    — 說明更正：v1.26.171 之後沒有任何掛勾會
hooks/lib/flush-pending-banners.js                 執行它，程式保留當手動查稽核紀錄的工具。
tests/update-banner.test.js                     — 改測新佇列檔；新增讀取／按行清除的測試
                                                   （含「讀完之後才寫進來的那筆不能被刪」）。
install.sh                                       — Section 4b's copy-to-~/.claude/hooks
                                                   fallback gains hooks/locales/*.json
                                                   alongside the existing hooks/lib/*.js
                                                   glob (gate-message-i18n task 7): same
                                                   mkdir -p + guarded cp shape, same
                                                   2>/dev/null || true silencing a fresh
                                                   checkout's still-missing directory.
scripts/update.sh                                — Same extension to section 2's copy;
                                                   unlike install.sh this one is not
                                                   silenced on failure — a failed cp
                                                   prints [WARN], matching the existing
                                                   hooks/lib failure path (v1.26.139).
install.ps1                                      — Symmetric extension found while
                                                   checking: the Windows installer's own
                                                   hooks\lib copy section gained the
                                                   identical hooks\locales\*.json copy.
scripts/update.ps1                               — Same extension to the Windows
                                                   updater's own hooks\lib copy section
                                                   (also found while checking, not named
                                                   in the task brief).
scripts/check-sync.sh                            — L3 deploy-drift check's dynamic
                                                   hooks/lib/*.js comparison-pair block
                                                   gained the same one-line extension
                                                   for hooks/locales/*.json, so a
                                                   fallback-location machine shows up as
                                                   drifted rather than silently stale.
scripts/check-sync.ps1                           — Same one-line extension, PowerShell
                                                   side.
README.md                                        — New Infrastructure bullet + FAQ entry
                                                   (gate-message-i18n task 7) documenting
                                                   hook message localization: what it
                                                   does, the resolution order in plain
                                                   terms, the three supported languages,
                                                   how to change it (ownmind_set_locale,
                                                   asked for via the AI; 'auto' reverts
                                                   to the OS language), when it takes
                                                   effect (immediate here, next session
                                                   start elsewhere), and that ja is
                                                   machine-generated pending a
                                                   native-speaker review — closing the
                                                   note Task 6 left open.
docs/README.zh-TW.md                             — Same entry, hand-written in
                                                   Traditional Chinese.
docs/README.ja.md                                — Same entry, hand-written in Japanese.
client/src/scripts/translate.mjs                 — Generalized with --dir <path> (Task 6,
                                                   gate-message-i18n): every file the
                                                   pipeline touches (zh/en/ja dictionaries,
                                                   .translate-cache.json, glossary.json,
                                                   en.override.json, ja.override.json) now
                                                   resolves relative to --dir instead of a
                                                   hardcoded client/src/i18n. Omitting --dir
                                                   stays byte-identical to the prior
                                                   behavior. en.json, ja.json, glossary.json
                                                   and both override files default to {} when
                                                   absent under --dir, so a brand-new
                                                   dictionary directory bootstraps on its
                                                   first run; only zh.json is required.
                                                   Exports parseDirArg, resolveI18nDir,
                                                   applyOverride and DEFAULT_I18N_DIR for
                                                   tests. Comments and console output
                                                   translated to English while the file was
                                                   touched (project i18n policy).
package.json                                     — New script translate:hooks runs
                                                   translate.mjs --dir hooks/locales.
.gitignore                                       — Added hooks/locales/.translate-cache.json,
                                                   mirroring the existing
                                                   client/src/i18n/.translate-cache.json
                                                   entry.
tests/hook-i18n.test.js                          — The three tests that used the (previously
                                                   unshipped) ja locale slot as scratch space
                                                   for a missing, corrupt or partial
                                                   dictionary file now stage a private copy
                                                   of i18n.js + locale.js under a throwaway
                                                   directory instead, since
                                                   hooks/locales/ja.json is real as of this
                                                   task and writing to or deleting it would
                                                   race tests/hook-locales-parity.test.js
                                                   under Node's parallel test-file execution.
                                                   Header comment updated to say why.
src/routes/memory.js                            — GET /init gains a `locale` field (Task 5,
                                                   gate-message-i18n): read from
                                                   users.settings.locale via the same
                                                   jsonb_set pattern onboarding_completed_at
                                                   already uses. New PUT /locale route,
                                                   registered ahead of PUT /:id (same ordering
                                                   fix as /enforcement-bundle): sets zh/en/ja
                                                   verbatim, or deletes the settings key
                                                   outright on 'auto'; any other value
                                                   rejected 400 before touching the row.
mcp/index.js                                    — New tool ownmind_set_locale ({ locale:
                                                   'zh'|'en'|'ja'|'auto' }); forwards to PUT
                                                   /api/memory/locale, same one-round-trip
                                                   shape as ownmind_delete_secret (the
                                                   smallest existing authenticated write tool
                                                   — ownmind_session_off/_on turned out to
                                                   make no server call at all). TYPE_MAP
                                                   banner label added. Fix round 1: after the
                                                   write succeeds, calls
                                                   refreshLocalCacheForLocale() so this
                                                   machine's own cache updates immediately;
                                                   response message states the true timing
                                                   (immediate here, next session start on
                                                   other machines).
tests/session-context-field-coverage.test.js    — NOT_FOR_THE_SESSION_CONTEXT gains `locale`:
                                                   not model-facing, only hooks/lib/locale.js
                                                   reads it, so the new init field needed
                                                   classifying rather than silently failing
                                                   this guard.
src/utils/syncToken.js                          — generateSyncToken now hashes
                                                   users.settings->>'locale' alongside
                                                   user_max/team_max (Task 5 fix round 1): a
                                                   locale write only touches users.settings,
                                                   never memories.updated_at, so without this
                                                   the token could never change on a locale-
                                                   only write and the conditional-sync client
                                                   would never notice. GET /sync-token and GET
                                                   /init both already call this one function,
                                                   so both stay in sync by construction.
                                                   Round 2 splits the two purposes the one
                                                   hash was serving: cache freshness keeps
                                                   generateSyncToken/validateSyncToken (wide
                                                   inputs, locale included, wire value
                                                   unchanged), and the iron-rule optimistic
                                                   lock gets generateIronRuleLockToken/
                                                   validateIronRuleLockToken (narrow inputs:
                                                   MAX(updated_at) + COUNT(*) over the user's
                                                   active iron rules — exactly the rows GET
                                                   /upgrade-status returns). One hash
                                                   (hashScopedState) and one comparison
                                                   (compareToken) still serve both, so they
                                                   cannot drift; the scope name is folded into
                                                   the lock's hash so a token from one family
                                                   can never satisfy the other by accident.
src/routes/admin-iron-rule-upgrade.js           — Round 2: all three call sites moved to the
                                                   iron-rule lock pair. Sharing the broad
                                                   token meant a user changing their own
                                                   language mid-edit got 409 "Iron-rule state
                                                   has changed" with no iron rule changed; the
                                                   same shared hash also fired on any
                                                   unrelated memory save. Wire field keeps its
                                                   sync_token name.
tests/sync-token-endpoint.test.js               — 3 new cases: locale changes -> token
                                                   changes (same user_max/team_max); clearing
                                                   the preference (auto, i.e. empty string)
                                                   also changes it; same locale + same
                                                   user_max/team_max stays idempotent.
                                                   Round 2: the cache-freshness token's wire
                                                   value pinned to literal bytes (every
                                                   installed machine holds one on disk and
                                                   re-inits when it moves, so a formatting
                                                   change must be deliberate, so two input
                                                   shapes are pinned); the lock token ignores
                                                   locale and reacts to each of its own
                                                   inputs; the two families hash differently
                                                   from identical inputs and a cross-family
                                                   token is rejected. These inject a fake
                                                   query, so they pin the hashing and say
                                                   nothing about which rows the SQL reads —
                                                   that is the real-database file's job.
tests/local-locale-refresh.test.js              — Round 2: adds the cache_fresh case, pinning
                                                   the success contract the doc comment now
                                                   states (a matching token means the cache
                                                   already reflects the server, so init is
                                                   never called and ok stays true).
mcp/lib/local-locale-refresh.js                 — Round 2 (doc only): the JSDoc now states
                                                   what ok claims — "the local cache reflects
                                                   the server's current state" — and why both
                                                   init_refreshed and cache_fresh satisfy it,
                                                   while cache_fallback and error do not.
tests/memory-locale-route.test.js               — Round 2: the sync-token scenario now pins
                                                   GET /init's embedded token too, and that
                                                   the two endpoints agree before and after
                                                   the write.
hooks/locales/ja.json                           — Cleanup batch (post-Task-7 review): restored the
                                                   leading space compliance.idNote lost — zh.json and
                                                   en.json both have it, and
                                                   hooks/lib/compliance-step.js concatenates this value
                                                   onto compliance.blockCapReached /
                                                   compliance.pushedBack with no separator, so the
                                                   Japanese output ran the two sentences together with
                                                   no gap.
hooks/locales/ja.override.json                  — Cleanup batch: pinned the corrected
                                                   compliance.idNote value (leading space included) so
                                                   a future translate:hooks re-run — which regenerates
                                                   this key whenever the .translate-cache.json entry
                                                   for it is invalidated — cannot silently drop the
                                                   space again; overrides apply last and always win.
tests/hook-locales-parity.test.js               — Cleanup batch, 3 fixes (TDD, each proved red first):
                                                   (1) new leading/trailing-whitespace-presence check
                                                   across zh/en/ja for every key — red against the
                                                   ja.json bug above, green after the fix; (2)
                                                   OTHER_PROTOCOL_LITERALS' dead /ownmind-off entry (no
                                                   dictionary value ever contained it) replaced with a
                                                   coverage assertion that fails loudly if any listed
                                                   literal is absent from zh.json, then the dead entry
                                                   itself removed; (3) quotedForm()'s regex used
                                                   independent open/close character classes
                                                   (["「]word["」]), which accepted a mismatched
                                                   ASCII-open/CJK-close pair — tightened to an explicit
                                                   alternation requiring a matching pair, with a new
                                                   test proving both the rejection and that both real
                                                   quoting styles still match.
hooks/lib/locale.js                             — Cleanup batch: closed a totality hole in getLocale()
                                                   — the {homeDir = os.homedir()} default parameter
                                                   only fires for undefined, so an explicit {homeDir:
                                                   null} skipped it and reached path.join(null, ...),
                                                   throwing and breaking the function's documented
                                                   "never throws" contract. No current call site passes
                                                   null; closed anyway as a latent hole. Falls back to
                                                   os.homedir() for any non-string or empty homeDir.
tests/hook-locale.test.js                       — Cleanup batch: new case asserting getLocale({
                                                   homeDir: null }) returns a valid locale instead of
                                                   throwing (TDD red before the locale.js fix, green
                                                   after).
```

新增：
```
tests/hook-locales-fallback-sync.test.js         — Task 7: lifts the real install.sh
                                                   section-4b and update.sh section-2
                                                   blocks by their section markers (same
                                                   "extract, don't restate" approach
                                                   tests/update-sh-upgrade-rule.test.js
                                                   uses for a different section). 5
                                                   cases against a staged
                                                   $OWNMIND_DIR/hooks tree: each script's
                                                   block lands all three locale files in
                                                   ~/.claude/hooks/locales; a stale
                                                   fallback dictionary is overwritten
                                                   rather than left behind on re-sync;
                                                   each block tolerates a checkout with
                                                   no hooks/locales directory at all.
                                                   Proved red against the pre-Task-7
                                                   originals first (ENOENT on
                                                   .../hooks/locales), then green again
                                                   against the patched scripts.
hooks/locales/glossary.json                      — Task 6: self-mapping term glossary for the
                                                   pipeline's --dir run against hooks/locales
                                                   — go, no, 誤判 and ⛔ each map to themselves
                                                   so the LLM copies these protocol literals
                                                   through instead of translating them, the
                                                   same mechanism
                                                   client/src/i18n/glossary.json uses for
                                                   brand terms.
hooks/locales/en.override.json                   — Task 6: pins all 24 hand-authored English
                                                   strings from Tasks 1-5 verbatim, so the
                                                   pipeline's English pass can never rewrite
                                                   the wordings regression-pinned in
                                                   tests/hook-i18n.test.js and
                                                   tests/hook-notices-i18n.test.js. Verified
                                                   byte-for-byte identical to
                                                   hooks/locales/en.json before committing.
hooks/locales/ja.override.json                   — Task 6: empty scaffold with only a
                                                   _comment key, mirroring
                                                   client/src/i18n/ja.override.json's shape.
                                                   Nothing needed a manual override once the
                                                   glossary self-mappings were in place.
hooks/locales/ja.json                            — Task 6: generated by `npm run
                                                   translate:hooks`
                                                   (client/src/scripts/translate.mjs --dir
                                                   hooks/locales, model gpt-oss-120b via the
                                                   shared kkvin.com/llm-switch proxy —
                                                   gpt-4o-mini and gpt-4o both hit the
                                                   proxy's broken mistral-ocr-* fallback
                                                   chain for this specific batch, reproduced
                                                   with curl outside the script). All 24 keys
                                                   present, no missing-translation warnings.
                                                   Wording has not had a
                                                   native-Japanese-speaker review pass yet
                                                   (Task 7 tracks that).
tests/translate-hooks-dir.test.js                — Task 6, TDD: unit tests for
                                                   parseDirArg/resolveI18nDir/applyOverride,
                                                   plus one full-script integration run in
                                                   manual mode (TRANSLATE_API_KEY unset, no
                                                   live LLM call) proving the pipeline reads
                                                   and writes only under --dir and never
                                                   touches client/src/i18n.
tests/hook-locales-parity.test.js                — Task 6, TDD (red before ja.json existed):
                                                   mechanical parity check across
                                                   hooks/locales/{zh,en,ja}.json — every key
                                                   exists in all three, every {placeholder}
                                                   set matches per key, the [OwnMind ...]
                                                   header and other protocol literals (⛔, 誤判,
                                                   /ownmind-on, /ownmind-off) survive
                                                   verbatim in ja.
tests/update-notice-delivery.test.js            — 把 Stop 掛勾當程式跑：待送的更新結果要
                                                   真的出現在 stdout 的 systemMessage、
                                                   送完要清佇列、沒東西時不能亂講話。
                                                   拿掉送出或拿掉清除都會紅。
tests/memory-locale-route.test.js               — Real-database route test (Task 5): PUT
                                                   /locale writes users.settings.locale via
                                                   jsonb_set, even from a row whose settings
                                                   column is SQL NULL; GET /init echoes the
                                                   value back; 'auto' deletes the key without
                                                   touching sibling keys; invalid values
                                                   rejected 400, never reaching the database;
                                                   no-auth request rejected 401. Same
                                                   startRealDb()/startServer() harness as
                                                   enforcement-bundle-mounted.test.js. Fix
                                                   round 1: a PUT /locale write changes this
                                                   account's sync_token (zh, then auto, each
                                                   differ from the last) while an unrelated
                                                   account's token stays put.
tests/mcp-set-locale-tool.test.js               — Source-level test for ownmind_set_locale
                                                   (mcp/index.js cannot be imported — it
                                                   connects a live stdio server on load, same
                                                   constraint memory-title-update.test.js
                                                   documents): schema shape, enum values,
                                                   English description, and that the case
                                                   handler forwards args.locale to PUT
                                                   /api/memory/locale. Fix round 1:
                                                   description and response wording state the
                                                   true propagation timing (immediate on this
                                                   machine, next session start on others);
                                                   case handler calls
                                                   refreshLocalCacheForLocale().
mcp/lib/local-locale-refresh.js                 — Task 5 fix round 1:
                                                   refreshLocalCacheForLocale({apiUrl, apiKey,
                                                   cachePath, fetchFn}) — thin wrapper around
                                                   hooks/lib/conditional-sync.js's own
                                                   runConditionalSync(), reused verbatim
                                                   rather than a second cache writer (that
                                                   file has one owner). Never throws; returns
                                                   {ok, source} so a failed refresh degrades
                                                   the tool's response text instead of failing
                                                   the call.
tests/local-locale-refresh.test.js              — 3 cases against a staged HOME: a pinned
                                                   locale change reaches cache.data.locale and
                                                   getLocale() returns it immediately; 'auto'
                                                   removes the value and getLocale() stops
                                                   returning the stale one; a fetch failure
                                                   degrades gracefully (ok:false, no throw,
                                                   existing cache left byte-for-byte
                                                   untouched).
tests/iron-rule-upgrade-lock-scope.test.js      — Round 2, real-database (startRealDb() +
                                                   startServer(), both routers behind their
                                                   real auth): with an iron-rule upgrade edit
                                                   open, a locale write moves the cache token
                                                   on both GET /sync-token and GET /init while
                                                   the open edit still commits 200 — the
                                                   regression this round fixes, and it fails
                                                   409 without the split. The lock still
                                                   locks: a background write to the rule under
                                                   the editor 409s, and the token that 409
                                                   hands back works first try; disabling a
                                                   NON-max rule by raw SQL (MAX asserted
                                                   unmoved either side) also 409s, which is
                                                   what makes COUNT(*) load-bearing rather
                                                   than decorative. An unrelated memory write
                                                   does not evict the editor. The 409 body is
                                                   asserted against shouldRetryForSyncToken()
                                                   so this lock's conflict can never be
                                                   mistaken for a stale cache token by the
                                                   MCP client's generic write retry.
                                                   Only a real database can settle this — the
                                                   claim is about which rows each query reads,
                                                   which fixtures cannot show.
```

## v1.26.172 修改（做事閘門第一步：閘門規範隨執行包下發 + 批准 CLI + PreToolUse 接線）

新增：
```
hooks/lib/action-gate.js                        — guard matching 與決策核心；evaluateGate、
                                                   approveAction、matchGuards 匯出。
hooks/lib/gate-receipt.js                       — 讀取回執子系統；writeReceipt、verifyReceipt、
                                                   ensureKey、ensureNonce。
hooks/lib/approve-action.js                     — 一次性批准 CLI；讀 session ID、驗碼、
                                                   終端列印 APPROVED／REJECTED。
hooks/lib/action-gate-cli.js                    — 閘門 CLI；stdin 收 hook payload、stdout 回
                                                   決策 JSON，放行時靜默、失效時明講。
tests/action-gate.test.js                       — guard matching、evaluateGate、approveAction
                                                   的 26 項單元測試（含邊界與安全檢查）。
tests/action-gate-e2e.test.js                   — 閘門接線端對端測試（CLI、.sh、.js 三面，
                                                   含 30 條日常指令零干擾包）。
tests/helpers/temp-dir.js                       — 測試用暫時目錄助手。
hooks/lib/gate-provision.js                     — session 佈建；密鑰＋nonce（被植入就重生）＋
                                                   gate-current-session＋30 天狀態清掃。
tests/gate-provisioning.test.js                 — 佈建端對端測試（spawn 兩份 SessionStart
                                                   hook 對 staged HOME，5 項）。
hooks/lib/i18n.js                               — total-function message lookup for hook user
                                                   notices; t(key, params?), resetI18nCacheForTests().
hooks/lib/locale.js                             — real locale resolver; getLocale({homeDir}):
                                                   OWNMIND_LOCALE_FORCE → account preference
                                                   (memories cache data.locale) → normalized
                                                   OS-detected state/locale.json → 'en'. Sync,
                                                   total, subprocess-free.
hooks/lib/locale-provision.js                   — SessionStart-only OS-locale detector (darwin
                                                   `defaults`, win32 PowerShell, else $LANG/$LC_ALL);
                                                   provisionLocale({homeDir}) writes
                                                   state/locale.json, never throws.
hooks/locales/en.json, hooks/locales/zh.json    — 24 keys (was 8): the gate.* / lint.* family
                                                   plus (task 4) the compliance.* and tty.*
                                                   families, keyed by the string-inventory
                                                   audience=user set.
tests/hook-i18n.test.js                         — t() + getLocale() OWNMIND_LOCALE_FORCE seam
                                                   unit tests (10 cases).
tests/hook-locale.test.js                       — getLocale() full resolution chain,
                                                   provisionLocale() null-on-failure behavior,
                                                   and SessionStart wiring end-to-end (16 cases).
tests/action-gate-i18n.test.js                  — the gate family through t(): zh userLine for
                                                   all 5 block variants, en byte-identical
                                                   regression pin, reason/decision fields locale-
                                                   independent, CLI/degraded/failopen notices
                                                   localized, and a broken-i18n.js e2e case for
                                                   all three entry points (action-gate-cli.js,
                                                   ownmind-iron-rule-check.js, approve-action.js)
                                                   proving fail-open never invents a block and
                                                   never crashes (19 cases).
tests/hook-notices-i18n.test.js                 — the remaining user notices through t():
                                                   reply-lint banner header (4 variants) +
                                                   mode-invalid + per-violation line +
                                                   /ownmind-off reminder + recovery, compliance-
                                                   step's 7 state/event banners, tty-echo's
                                                   merged-banner header; zh + en-byte-identical
                                                   pairs, decision-field locale-independence,
                                                   one broken-i18n.js proof per file (35 cases).
```

修改：
```
hooks/ownmind-iron-rule-check.sh                — 觸發詞偵測前先過做事閘門；閘門有輸出就
                                                   原樣轉發並就地結束；fail-open literals now
                                                   carry a comment on why they bypass t().
hooks/ownmind-iron-rule-check.js                — 同上（Windows twin）；直接 import 閘門
                                                   模組，同一套 fail-open-loud 包法; failopen/
                                                   degraded notices route through gateNotice()
                                                   (dynamic import of t(), English literal
                                                   fallback on failure).
hooks/ownmind-session-start.sh                  — 開場即佈建閘門狀態（憑證檢查之前）；
                                                   stdin payload 原樣交給 gate-provision.js;
                                                   locale-provision.js is now invoked at the same
                                                   pre-credential position (no stdin required).
hooks/ownmind-session-start.js                  — 同上（Windows twin）；讀 stdin 取
                                                   session_id、動態 import 佈建函式; adds
                                                   provisionOsLocale() right after provisionGate().
hooks/lib/action-gate.js                        — the 4 userLine sites (verbal ask, code-mode
                                                   ask/limit, read-block, check-block) now go
                                                   through t(); model-facing reason untouched.
hooks/lib/action-gate-cli.js                    — failopen/degraded notices route through
                                                   gateNotice() (dynamic import of t(), English
                                                   literal fallback on failure).
hooks/lib/approve-action.js                     — review fix: action-gate.js loaded via dynamic
                                                   import inside try/catch, so a broken i18n.js
                                                   still prints REJECTED (previously the whole
                                                   CLI crashed with empty stdout).
tests/action-gate.test.js                       — pin OWNMIND_LOCALE_FORCE=en for the whole
                                                   suite (predates locale support; several
                                                   assertions pin literal English userLine text).
tests/helpers/hook-home.js                      — staged home 加掛 hooks/lib 目錄。
hooks/lib/compliance-step.js                    — the 7 state/event banners (off/warn-mode,
                                                   no-credentials, never-synced, check-failed,
                                                   server-off, block-cap-reached, pushed-back)
                                                   now go through t() via a complianceNotice()
                                                   dynamic-import-with-fallback helper; the
                                                   誤判 check-id note is its own resolved
                                                   {idNote} param, not string-spliced.
hooks/ownmind-reply-lint.js                     — lint.recovered wired at its emit site; new
                                                   lintNotice() helper; the /ownmind-off
                                                   reminder and formatBanner()'s 4 header
                                                   variants + mode-invalid line + per-violation
                                                   line now go through t(); formatBanner() is
                                                   now async, its one call site awaits it.
hooks/ownmind-tty-echo.cjs                      — merged-banner header (tty.header) now goes
                                                   through t() via ttyNotice(); dynamic
                                                   import() works from this CommonJS file even
                                                   though static import and require() of an ESM
                                                   sibling do not (verified empirically).
tests/enforcement-compliance-step.test.js       — pin OWNMIND_LOCALE_FORCE=en (calls
                                                   runComplianceStep() directly, in-process,
                                                   against the real machine's env/home).
tests/reply-lint-hook.test.js                   — pin OWNMIND_LOCALE_FORCE=en (asserts /Reply
                                                   quality lint/).
tests/reply-lint-hook-v1193-block.test.js       — pin OWNMIND_LOCALE_FORCE=en (asserts
                                                   /fallback|falling back/).
tests/reply-lint-hook-v1911.test.js             — pin OWNMIND_LOCALE_FORCE=en (asserts
                                                   /consecutive blocks/).
tests/reply-lint-hook-v197.test.js              — pin OWNMIND_LOCALE_FORCE=en (defensive).
tests/enforcement-reply-lint-wiring.test.js     — pin OWNMIND_LOCALE_FORCE=en (asserts
                                                   /never synced/, /NOT checked/).
tests/ownmind-tty-echo.test.js                  — pin OWNMIND_LOCALE_FORCE=en (defensive).
```

## v1.26.171 修改（規範真的被挑到，系統講的話真的被看到）

修改：
```
src/lib/enforcement/select-rules.js             — matchesTag 接受標籤清單（任一對上即可）；
                                                   trigger:always 升到 rank 0，預算擠不掉。
hooks/lib/compliance-step.js                    — skipped+enabled:false 與缺憑證都改成明講
                                                   「這一輪沒檢查」；擋下訊息帶查核編號。
hooks/lib/compliance-client.js                  — 把伺服器的 enabled 欄位傳回決策層。
hooks/ownmind-reply-lint.js                     — 通知通道重建：/dev/tty 廢除，改 stdout
                                                   systemMessage JSON；降級警告 exit 1→0。
hooks/ownmind-session-start.sh / .js            — 不再於開場把通知備援檔灌進模型後清空；
                                                   備援檔改為純稽核紀錄（寫入端 1MB 輪替）。
hooks/ownmind-tty-echo.cjs                      — 同病同修：/dev/tty 廢除，改 stdout
                                                   systemMessage JSON；稽核檔照寫。
tests/ownmind-tty-echo.test.js                  — 改測新通道契約。
hooks/lib/notice-throttle.js                    — 新增：狀態類提醒節流（變化講、恢復講、
                                                   持續中每 10 輪提醒）。
tests/enforcement-notice-throttle.test.js       — 節流規則的單元測試。
tests/enforcement-judge.test.js                 — 陣列 trigger 與 always 排序的重現測試。
tests/enforcement-compliance-step.test.js       — skipped／缺憑證要出聲、編號進 stderr。
tests/enforcement-reply-lint-wiring.test.js     — systemMessage 真的上 stdout、安靜輪全空白。
tests/reply-lint-hook.test.js                   — stdout 契約改為「空白或單一 JSON 物件」。
tests/reply-lint-hook-v197.test.js              — 降級改 exit 0 + systemMessage。
tests/reply-lint-hook-v1911.test.js             — 同上。
openspec/changes/v1.26.171-rules-actually-selected-and-heard/ — proposal / spec / tasks。
```

## v1.26.170 修改（標籤清單在最後一哩被丟掉）

修改：
```
src/routes/compliance.js                        — trigger 收到陣列不再被coerce 成空字串。
                                                   線上實測抓到：309 條規範送達，符合標籤的
                                                   一條都沒進判斷，而回應是「skipped」。
tests/enforcement-compliance-route.test.js      — 補重現測試：帶標籤的規範必須真的送到判官
                                                   面前，不能只是沒有報錯。
```

## v1.26.169 修改（第三道關卡接上了）

新增：
```
hooks/lib/compliance-step.js                    — 這一輪要做什麼的決策函式。本機先篩、失敗必留痕、
                                                   退回次數自己算（不共用 lint 的門檻）。團隊規範
                                                   的回饋會多一句「使用者說了不算」。
hooks/lib/compliance-client.js                  — 送查核請求。Bearer 認證、5 秒逾時、失敗後退避、
                                                   送出前先遮蔽密碼權杖形狀的字串。
tests/enforcement-compliance-step.test.js       — 決策的各種分支。
tests/enforcement-compliance-client.test.js     — 認證標頭、退避、遮蔽。
tests/enforcement-reply-lint-wiring.test.js     — 把 hook 當程式跑，驗它真的走到檢查、而且在
                                                   「重寫」那條早退之前。抓到 readCredentials
                                                   不在作用域的就是這個檔。
```

修改：
```
hooks/ownmind-reply-lint.js                     — 合規檢查插在 stop_hook_active 早退之前；逐字稿
                                                   只讀一次，後面重用。依賴全部動態載入且各自 catch，
                                                   壞一支不能拖垮既有三個檢查。
hooks/lib/compliance-step.js
src/lib/enforcement/select-rules.js             — trigger 改成可接多個標籤：一則回覆同時是「回話」
                                                   也是「回報」。
```

## v1.26.168 修改（判斷者：伺服器端）

新增：
```
db/025_enforcement.sql                          — users.enforcement_mode（預設 off）＋
                                                   compliance_checks。outcome 刻意把
                                                   skipped/failed 跟 clean 分開，否則「沒跑」
                                                   會長得跟「跑了沒事」一樣。
src/lib/enforcement/select-rules.js             — 挑這一輪要判的規範。寧可多挑，只用預算擋；
                                                   超大的規範會被跳過而不是讓後面全部消失，
                                                   被跳過的會回報給呼叫端記錄。
src/lib/enforcement/judge-prompt.js             — 給判官的提示與回覆驗證。吃已解析的物件，
                                                   因為 callLLMSwitch 回的就是物件。
src/routes/compliance.js                        — POST /check 與 /feedback。帳號開關第一關；
                                                   撈規範用 buildReadableWhere ＋ 併片段。
tests/enforcement-judge.test.js                 — 挑選與提示，含「回傳形狀不能漂移」。
tests/enforcement-compliance-route.test.js      — 端點行為，其中一條走真的 callLLMSwitch
                                                   打樁伺服器，釘住那個曾經害整套失效的接縫。
```

修改：
```
src/app.js                                      — 掛 /api/compliance。
tests/helpers/real-db.js                        — 容器埠改成依行程編號，避免偶發互撞。
```

## v1.26.167 修改（四種規範，四句不同的話）

修改：
```
hooks/ownmind-prompt-inject.js                  — PRECEDENCE_SENTENCE 改成 PRECEDENCE_BY_TYPE，
                                                   四種各一句；未知型別有 fallback（沒有句子
                                                   就等於回到事故當時的狀態）。標頭也改成講
                                                   實際型別，不再一律叫 standard。
src/routes/enforcement-bundle.js                — selectors/guards/injectables 都帶上 type。
hooks/lib/path-guard.js                         — 擋下來的訊息依 type 分兩種，跟注入時一致。
tests/enforcement-prompt-inject.test.js         — 四種各一條，另加「每個型別都要有句子」。
tests/enforcement-path-guard.test.js            — 團隊規範要求「確認」、個人規範不要求。
tests/enforcement-bundle.test.js                — type 必須被送出去。
```

## v1.26.166 修改（開工之前，規範先擺到眼前）

新增：
```
hooks/ownmind-prompt-inject.js                  — UserPromptSubmit hook。比對純本機（訊息
                                                   不出機器、不加來回）。注入第一句固定是
                                                   優先權宣告，再來禁區路徑與負責人，最後
                                                   才是本文。去重狀態落在檔案，因為每則訊息
                                                   都是新行程。沒同步過的機器會明講。
tests/enforcement-prompt-inject.test.js         — 含優先權那句必須在本文之前、以及把 hook
                                                   當程式跑兩次驗去重真的跨行程。
tests/enforcement-inject-registration.test.js   — 讀寫完之後的 settings.json 來斷言，不是
                                                   grep 原始碼（註解掉的註冊也會通過 grep）。
```

修改：
```
scripts/install-helpers/ensure-pretooluse-hooks.cjs — 抽出 ensureEntry()，讓 UserPromptSubmit
                                                   跟既有工具攔截共用同一套加/修/不動邏輯。
                                                   升級路徑也會拿到。
tests/ensure-pretooluse-hooks.test.js           — 「已經正確」的 fixture 補上新 hook；少了它
                                                   等於斷言「缺一個 hook 不算要修」。
```

## v1.26.165 修改（第一道真的擋得住的關卡）

新增：
```
hooks/lib/path-guard.js                         — 禁區判斷。repo 由被編輯檔案的目錄解析，
                                                   不是工作目錄。比對前兩邊都先過 realpath
                                                   （mac 的 /var 與 /private/var 是同一處，
                                                   直接比字串會讓檔案看起來在 repo 外面）。
                                                   findContentMention 另外接住「文件內文在
                                                   提議改禁區」這種路徑擋不到的情況。
tests/enforcement-path-guard.test.js            — 含跨 repo 那一條：session 在 A、改 B 的
                                                   禁區檔，必須擋。
tests/enforcement-edit-guard.test.js            — 最後一條把 payload 灌進真的 .sh，驗 block
                                                   有走到輸出。這是唯一能發現「擋寫在錯的
                                                   檔案裡」的測試。
```

修改：
```
hooks/ownmind-edit-reminder.js                  — 擋的出口在節流之前，且與 verification
                                                   engine 無關。stdin 改成只讀一次（session id
                                                   與檔案路徑同一份 payload），且只在真的有
                                                   管線輸入時讀。
hooks/ownmind-iron-rule-check.js                — edit 分支把 file_path 與內文傳下去（Windows
                                                   走的是這條，不傳等於那個平台沒有擋）。
```

## v1.26.164 修改（規範終於會走到你的電腦上）

新增：
```
hooks/lib/enforcement-cache.js                  — 規範 bundle 的讀寫。readEnforcementBundle
                                                   回 present 旗標，分得出「沒有規範」跟
                                                   「從來沒同步過」。mayReplaceBundle 擋掉
                                                   空回應覆蓋既有快取。自己一個檔案，因為
                                                   memories.json 的形狀由 compact init 決定，
                                                   而且 holdsInitPayload 會拒收型別鍵。
tests/enforcement-cache.test.js                 — 讀寫、present 旗標、空回應保護。
tests/enforcement-sync-cli.test.js              — 行程內對真伺服器驗行為，另用真的把 CLI
                                                   當程式跑一次，驗 main() 真的走到同步。
```

修改：
```
hooks/lib/conditional-sync-cli.js               — 加 syncEnforcementBundle()，排在 init 同步
                                                   之前且不依賴它。改成只有被當程式執行時才
                                                   跑 main()（用 realpath 比對，不比字串），
                                                   這樣測試才能在行程內驅動它。
```

## v1.26.163 修改（那條規範不是你上傳的，所以你看不見它）

新增：
```
src/routes/enforcement-bundle.js                — 規範配送端點。buildBundle() 把資料庫的
                                                   巢狀 metadata 攤平成三份清單：selectors
                                                   （每條規範、不含內文）、guards（禁區路徑）、
                                                   injectables（帶內文、只含被標註的）。查詢
                                                   用 buildReadableWhere，否則看不到別人上傳
                                                   的團隊規範。
tests/helpers/stub-llm.js                       — 冒充 callLLMSwitch 要打的那個模型端點。
                                                   一個接縫只准有一端是假的，假的是上游模型，
                                                   受測的助手函式保持真的。
tests/helpers/real-db.js                        — 起一個真的 Postgres 並套上本 repo 全部的
                                                   migration。跨帳號可見性與片段組裝只寫在
                                                   SQL 裡，注入假資料列證明不了它們。docker
                                                   不在時回 null，呼叫端要大聲 skip。
tests/enforcement-seams.test.js                 — 釘住 callLLMSwitch 的回傳型別與請求內容。
                                                   把它改成回原始字串，兩條當場轉紅。
tests/enforcement-bundle.test.js                — buildBundle 的形狀，以及註冊順序（/:id 會
                                                   把 enforcement-bundle 當 id 吃掉）。
tests/enforcement-bundle-mounted.test.js        — 真資料庫 + 真路由 + 真認證。事故當時的資料
                                                   形狀：規範屬於同事、禁止清單在子片段。把
                                                   查詢換回 user_id = $1 就轉紅。
```

修改：
```
src/routes/memory.js                            — 在 router.get('/:id') 之上掛
                                                   /enforcement-bundle。掛在下面的話 Express
                                                   會把它當成一個 id，整數轉型失敗回 500。
```


## v1.26.162 修改（兩 GB 的那個檔案）

修改：
```
shared/scanners/claude-code.js                  — defaultReadIncremental 改分段讀（單次
                                                   fs 讀取上限 8 MiB），並限制一次掃描
                                                   最多取 64 MiB；超過就停在行尾、下次
                                                   續讀。切點改用 buf.lastIndexOf(0x0a)
                                                   在位元組上找，不再從解碼後的字串回推
                                                   長度（多位元組字元被切開會讓位置偏掉）。
                                                   壞掉的位置記錄回到 0 而不是餵 NaN 給
                                                   Buffer.alloc；單行超過上限丟
                                                   OWNMIND_LINE_TOO_LONG（接得住的錯誤，
                                                   會被上層跳過並記進紀錄）。codex adapter
                                                   共用這個函式，一起修好
scripts/install-helpers/self-check.cjs          — 查排程多要一行 OWNMIND_LASTRESULT，
                                                   state=Ready 但上次結果非 0 就判 fail；
                                                   新增並匯出 taskRunFailed（0x000413xx
                                                   是排程系統自己的狀態碼，不是失敗）
tests/scanner-claude-code.test.js               — 四案：分段讀不會把超過上限的長度交給
                                                   fs、停在上限後續掃會排空且每次都前進、
                                                   單行過長丟得出接得住的錯、壞掉的位置
                                                   記錄從 0 重讀；另一案驗切點落在多位元組
                                                   字元中間時位置仍然精準（把切點改回從
                                                   字串回推就會紅）
tests/self-check.test.js                        — taskRunFailed 四案：成功與排程狀態碼
                                                   不算失敗、行程退出碼算失敗（含 0x86）、
                                                   吃得下 '0x86' 字串、讀不到就不判
package.json / README.md / docs/README.ja.md
docs/README.zh-TW.md / CHANGELOG.md             — 版號與更新紀錄
```

## v1.26.161 修改（窗戶只關了一半）

新增：
```
tests/command-listing-obeys-window.test.js      — 驗 ⚠️ 清單跟名字受同一個窗戶管。
                                                   八個案例：第一次印、第二次不印、
                                                   換 trigger 照印、換 session 照印、
                                                   commit 一律不印、什麼都沒比對到就
                                                   不開窗、窗過期又印回來。
                                                   改動前跑過：只有「第二次不印」是紅的，
                                                   其餘七個綠——所以它證明的是這一個defect，
                                                   不是順手把別的行為一起改掉了
tests/relay-asks-for-a-quiet-line.test.js       — 驗轉述指示有講排版（引用區塊＋斜體），
                                                   而且沒有把「要翻譯」「數字照抄」擠掉
tests/edit-reminder-english-source.test.js      — 驗編輯路徑那兩個檔整份沒有中日韓字
                                                   （含假名、諺文、全形標點，不是只有漢字）。
                                                   掃整個檔案而不是挑幾個字串比對：
                                                   挑著比對的清單，漏掉的那條不會報錯。
                                                   另有一案驗「翻成英文的字串一定帶著
                                                   轉述指示」——只翻不帶指示，對原本讀
                                                   得懂中文的人是退步
```

修改：
```
hooks/ownmind-render-context.js                 — `listing` 提到外層，⚠️ 清單也受它管；
                                                   空 session id 那段註解改寫（它現在少給的
                                                   東西比 v1.26.154 寫那段時多）
shared/hook-context.js                          — 轉述指示加上排版要求；抽成 RELAY_INSTRUCTION
                                                   匯出，讓單獨送英文字串的呼叫端帶得走；
                                                   新增 suffix 參數，次數改放進句子裡面
hooks/ownmind-edit-reminder.js                  — 四個中文字串改英文原稿，各自配轉述指示；
                                                   框框的指示明講「鐵律標題不准翻」
shared/edit-reminder-state.js                   — 節流那行改英文原稿
tests/edit-trigger-reminder.test.js             — 斷言跟著改英文；「不准宣稱已遵守」
                                                   那條的關鍵字也改英文（原本的中文
                                                   關鍵字對英文的行會無條件通過）
tests/hook-context-five-categories.test.js      — 渲染器測試改用隔離的狀態檔與 session id。
                                                   原本讀寫開發者自己的
                                                   ~/.ownmind/state/edit-reminder.json
```

## v1.26.160 修改（有找到的，就要念出名字）

新增：
```
tests/names-include-iron-rules.test.js          — 驗每小時那份名單會把鐵律也念出來。
                                                   三個呼叫端各測一次（不是只測共用排版
                                                   那支——排版那支本來就沒意見，
                                                   排除鐵律的邏輯在呼叫端）。
                                                   另有一案驗框框照樣會印，
                                                   免得日後有人「整理」時把框框刪掉
                                                   還一路綠燈。
                                                   已拿改動前的程式驗過：四案紅三案。
```

修改：
```
hooks/ownmind-edit-reminder.js                  — 名單整份傳過去，不再濾掉鐵律
hooks/ownmind-iron-rule-check.js                — 同上，且所有觸發情境一致
hooks/ownmind-render-context.js                 — 同上，並拿掉只為了做這個排除而存在的
                                                   commit／非 commit 分岔
shared/hook-context.js                          — 只有註解：原本描述的規則已不成立
```

## v1.26.159 修改（5264 個沒人負責的資料夾）

新增：
```
tests/helpers/temp-dir.js                       — 借出暫存目錄的唯一窗口。tempDir(前綴)
                                                   借出，並在借它的那支檔案跑完時收回去。
                                                   收不掉（Windows 上被子行程鎖住）會寫到
                                                   stderr 但不會讓整套變紅——安靜失敗等於
                                                   把問題原封不動放回去。
                                                   刻意支援 await：原本的呼叫端有同步也有
                                                   非同步，await 一個字串就是那個字串，
                                                   所以非同步那些不用改寫成別的形狀。

tests/no-unregistered-temp-dir.test.js          — 守門測試。tests/ 底下任何檔案自己去要
                                                   暫存目錄就紅，並指名是哪一支。
                                                   另外驗自己兩件事：比對規則還認得出它
                                                   禁止的寫法（不然哪天改壞了會因為什麼都
                                                   沒比到而變綠）；以及那條唯一許可的路
                                                   真的會收乾淨——另開行程、把暫存位置指到
                                                   空資料夾，先確認那個行程真的有跑，
                                                   再看資料夾裡還剩什麼。
```

改用共用工具（80 支檔案、106 個地方，機械式替換）：
```
fs.mkdtempSync(path.join(os.tmpdir(), 'x-'))  →  tempDir('x-')
```
本來就有自己收尾的檔案保留原本的收尾（同一個目錄刪兩次不算錯）。
漏最兇的十支：ensure-key-file、ensure-session-hook、resolve-credentials、
installer-key-update、self-check-memory-load、cache-account-fingerprint、
post-commit-version-reminder、update-sh-upgrade-rule、node-hook-reports-init、
mcp-start-cmd。

## v1.26.158 修改（藥早就配好了，只發給一半的人）

新增：
```
tests/no-raw-listen-with-fetch.test.js          — 守門測試。任何測試檔同時用了 .listen(0)
                                                   跟 fetch( 卻沒引用 helpers/app-server.js
                                                   就紅。並且點名這次搬的 12 支，
                                                   拿掉 import 會以檔名報錯，而不是變成一個
                                                   每次跑都飄到不同檔案的紅字。
                                                   還會斷言自己的前提：fetch 真的會拒絕
                                                   6000 埠——哪天不拒絕了，這條會紅並說明，
                                                   helper 跟守門就都可以刪。
```

改用共用 helper（12 支，每支寫法都不同，一支一支改）：
```
tests/team-overview-last-active.test.js         — 實際紅掉的那一支
tests/changelog-feed.test.js                    — Promise 包住的 listen
tests/dashboard-version-source.test.js          — 同上
tests/debug-route-beacon-version.test.js        — 埠號寄放在 app._server
tests/upgrade-complete-beacon.test.js           — 同上
tests/bootstrap-routes.test.js                  — createServer + listenApp
tests/spa-deep-link-base.test.js                — 同上
tests/heartbeat-per-machine.test.js             — 每次請求開一台
tests/install-started-beacon.test.js            — 在 before 開
tests/install-check-null-byte-sanitize.test.js  — 在 beforeEach 開
tests/bare-mount-trailing-slash.test.js         — 整個請求寫在 listen 回呼裡。
                                                   rawRequestLocation 的原始 listen(0) 保留：
                                                   那是直接往 socket 寫手工請求，
                                                   封鎖清單是 fetch 才有的規則。
tests/legacy-console-manifest.test.js           — 同上（回呼裡發請求）
```

## v1.26.157 修改（那張認得哪些字的表，從來沒人在寫入時查過）

新增：
```
tests/unknown-trigger-tags.test.js              — 帳號上實際找到的 11 個死標籤全部要被抓到；
                                                   表裡每一個字都要被接受，而且
                                                   ruleMatchesTrigger 仍要認它——兩者必須
                                                   同構，否則會對「其實會動的標籤」發警告，
                                                   那會教作者忽略下一次；一般標籤不受影響；
                                                   undefined / null / 裸字串 / 混雜陣列不炸；
                                                   兩條寫入路徑都要掛上，而且都不准變成 4xx。
```

修改：
```
shared/helpers.js                               — 新增 KNOWN_TRIGGER_WORDS（從
                                                   TRIGGER_TAG_ALIASES 推導，不另寫一份，
                                                   手寫第二份就是同一個缺陷升一層）、
                                                   unknownTriggerTags（只判 trigger: 開頭、
                                                   大小寫不敏感、原字回傳）、
                                                   unknownTriggerTagWarning（講會發生什麼、
                                                   列出真的存在的時機、並說明「不加標籤」
                                                   本來就是合理答案）。

src/routes/memory.js                            — 新增與更新兩條路徑的回應都多帶一個
                                                   warning 欄位。更新那條特別重要：
                                                   tags 是整組取代不是合併，所以那裡正是
                                                   「會動的標籤被弄掉」或「死標籤被帶進來」
                                                   的時刻。純新增欄位，狀態碼與既有欄位
                                                   一律不動。
```

## v1.26.156 修改（搜尋用空白切字，而中文沒有空白）

新增：
```
tests/memory-search-cjk.test.js                 — 中文搜尋的回歸測試。實際回報的查詢
                                                   「收工六項自檢」要中；原本就會中的三個
                                                   要繼續中；兩條不相干的記憶不准被拖進來
                                                   （放寬過濾條件的全部風險就在這裡）。
                                                   另外釘住 SQL 形狀：只碰標題與內文、
                                                   窗格用一個轉義過的陣列參數送、
                                                   以及 ORDER BY 仍指向第一個詞的整塊參數
                                                   ——參數編號會因為窗格陣列多跳一格，
                                                   指錯了是 query 當下才炸的型別錯誤，
                                                   沒有資料庫的單元測試看不到。
```

修改：
```
shared/memory-search-tokens.js                  — 整塊比對不到時，改用兩字一組互相重疊的
                                                   窗格再試一次。新增 isBigramEligible
                                                   （含中文且至少四字）、bigrams、
                                                   bigramThreshold（六成，下限一）。
                                                   只比對標題與內文，不碰 code 與標籤
                                                   （那是識別碼，部分吻合沒有意義），
                                                   而且每個欄位分開數，不合併計算。

src/utils/memory-search-query.js                — 同一條規則寫成 SQL：
                                                   (SELECT count(*) FROM unnest($n::text[]) g
                                                    WHERE title ILIKE g) >= T。
                                                   參數編號改成邊走邊配，因為一個中文詞會
                                                   吃掉兩格（整塊 + 窗格陣列）。
```

## v1.26.155 修改（有一條團隊規範從來沒有響過）

修改：
```
shared/helpers.js                               — detectCommandTrigger 新增「對外送出」分支：
                                                   gh issue|pr create|comment|edit|review|
                                                   close|reopen 與 git send-email。
                                                   gh release create|edit|upload 放在部署那組
                                                   （它發布的是建置產物）。抓得窄：
                                                   gh issue list / gh pr view 不中。
                                                   TRIGGER_TAG_ALIASES 新增 send，
                                                   publish / 發布 / 發佈 同時屬於 send 與
                                                   deploy——「發布新版本」是部署、
                                                   「發布一篇文章」是對外送出，字面分不出來，
                                                   而寫記憶的人不會知道自己的標籤落在哪一邊。
                                                   deploy 也補上缺的 發佈（正體字形）。

shared/hook-context.js                          — TRIGGER_LABELS.send = 'Outward send'。
                                                   不叫 Deploy 也不叫 Publish：那兩個都讀起來
                                                   像在出軟體，而這個動作在你回一則 issue 留言
                                                   時也會跳。

tests/iron-rule-trigger-parity.test.js          — 兩份分類器共用的對照表新增四條會中的、
                                                   兩條不該中的（gh issue list、gh pr view）、
                                                   gh release create 歸部署、以及
                                                   「gh pr create && git push」仍然是部署，
                                                   確認既有分類沒有被新分支搶走。

tests/iron-rule-trigger-aliases.test.js         — 新增「對外送出」一節：
                                                   publish/發布/發佈 兩邊都中、
                                                   部署專用字彙不會跟著過去、
                                                   send 標籤不會在 commit 或改檔案時中。
```

## v1.26.154 修改（那個數字沒有讓任何人去讀它）

修改：
```
shared/hook-context.js                          — tallyHookContext 多回傳 totals（在過濾之前
                                                   數，所以是「總共幾條」不是「幾條通過」）
                                                   與 names（每一類中的記憶標題）。
                                                   renderHookContextLine 改成句子形式、
                                                   分子/分母、以及可省略的名單段落。
                                                   伺服器沒送 totals 時退回單純數字，
                                                   不自己編一個分母出來。

shared/edit-reminder-state.js                   — 新增 windowKey(sessionId, trigger)，
                                                   讀寫都吃 trigger，所以 commit、部署、
                                                   改檔案各自算一小時。舊的狀態檔以純對話
                                                   編號為鍵，讀不到就是多列一次，安全方向。
                                                   decideEditReminder 一併帶 totals，
                                                   但刻意不帶 names——名單正是時間窗要擋的。
                                                   （檔名現在比它的職責窄，這版不改名：
                                                   四個呼叫端加兩支掛勾同時動風險太高。）

src/routes/memory.js                            — /hook-context 一併回傳 totals 與 names，
                                                   用的是同一批查回來的列，沒有第二次查詢。

hooks/ownmind-render-context.js                 — 多吃一個 sessionId 參數（stdin 已經被
                                                   回應內容佔住），套用時間窗；印橫幅的
                                                   觸發種類會把鐵律從名單裡拿掉，避免同一份
                                                   清單在兩個地方各印一次。

hooks/ownmind-iron-rule-check.js                — JS 那一份掛勾套用同一個時間窗、同樣的鍵值。
                                                   一個只存在於兩份實作其中一份的防護，
                                                   等於行為取決於平台裝到哪一份。

hooks/ownmind-edit-reminder.js                  — 改用 (sessionId, 'edit') 的鍵值；
                                                   帶上 totals；名單排除鐵律（下面的橫幅
                                                   已經在列了）。

hooks/lib/hook-context-fetch.js                 — 把 totals / names 原樣帶過去。兩者可以是
                                                   undefined：v1.26.151~153 的伺服器會回新的
                                                   形狀但沒有這兩個欄位，補零會變成宣稱查過。

hooks/ownmind-iron-rule-check.sh                — payload 現在吐三行：session_id、tool_name、
                                                   指令（指令可能含換行，所以它擁有結尾）。
                                                   session_id 本來被丟掉，指令那條路因此沒有
                                                   東西可以當時間窗的鍵。
```

## v1.26.153 修改（一支測試每跑一次留 23 個垃圾目錄）

新增：
```
tests/sync-rules-block-no-temp-leak.test.js     — 守門測試。把 sync-rules-block.test.js 當
                                                   子行程跑，並用 TMPDIR/TEMP/TMP 把它的暫存
                                                   位置導到一個空目錄，跑完剩下什麼就是它漏的。
                                                   受測檔案不需要為了被量測而改任何一行。
                                                   自帶反向檢查：先確認子行程真的跑了整個檔案
                                                   （至少 20 條過），才相信目錄講的話 —— 沒跑
                                                   起來留下的也是空目錄，兩者從外面看一模一樣。
                                                   會把 NODE_TEST_CONTEXT 與
                                                   NODE_TEST_WORKER_ID 從子行程環境拿掉，否則
                                                   子行程會切成序列化格式、輸出裡沒有 pass N。
```

修改：
```
tests/sync-rules-block.test.js                  — fixture() 建的暫存目錄記進 fixtureDirs，
                                                   檔案層級的 after 掛勾統一刪。用 after 而不是
                                                   每條測試各自 t.after()：拿 t 就得幫 23 條
                                                   it() 都加參數。after 不管過不過都會跑，而
                                                   斷言失敗那次才是漏最兇的。清理失敗寫 stderr
                                                   但不讓整套變紅 —— 安靜吞掉等於把缺陷原樣裝
                                                   回去。所有測試主體與斷言一字未動。
```

## v1.26.152 修改（那行字被寫死成中文 — issue #94 更正）

修改：
```
shared/hook-context.js                          — HOOK_CONTEXT_TYPES 與 TRIGGER_LABELS
                                                   改回英文原稿；renderHookContextLine
                                                   多帶一句轉述指示（要翻譯、但條數與版本號
                                                   照抄）。檔頭記下這條路線的出處：
                                                   render-session-context.js:164 的啟動提示
                                                   早就這樣做了。
hooks/ownmind-render-context.js                 — 新路徑不再多印一次「鐵律 N 條」標題
                                                   （上面那行已經有 Iron rules N）。
                                                   退回舊端點時印的中文原封不動 ——
                                                   那是使用者一直看到的東西。
tests/hook-context-five-categories.test.js      — 斷言改英文；新增「標籤裡不准有中日韓字」
                                                   與「必須叫模型翻譯、且指名數字要照抄」
package.json                                    — 1.26.151 → 1.26.152
```

## v1.26.151 修改（提醒只講鐵律，五類記憶只撈了一類 — issue #94）

新檔：
```
shared/hook-context.js                          — 五個類別、順序、trigger 顯示名稱、
                                                   那行字的算繪，以及 tallyHookContext。
                                                   順序照「破例的權力」排：團隊規範一個人
                                                   破不了例，排第一；鐵律是自己訂的可以當場
                                                   決定，排第二。也順便讓個位數的類別
                                                   不被 70+ 條的鐵律擠掉。
                                                   tally 是純函式、跟路由分開，
                                                   所以「哪些列算數」可以不接資料庫測。
hooks/ownmind-render-context.js                 — shell 掛勾的算繪，從內嵌 node -e 搬出來。
                                                   從 body 自己認出是新舊哪種回應，
                                                   不靠 shell 告訴它 —— shell 以為抓到什麼
                                                   和實際抓到什麼不一致時，不會印出錯的行。
                                                   兩種都不是就 exit 1（見下方 IR-002）。
hooks/lib/hook-context-fetch.js                 — 帶退路的抓取，.js 掛勾與編輯提醒共用。
tests/hook-context-five-categories.test.js      — 算繪、tally、兩種回應形狀，
                                                   外加跑真的 .sh 掛勾（含退路與它的記錄）
openspec/changes/v1.26.151-five-categories-not-one/
  proposal.md / spec.md / tasks.md               — 為什麼是一支端點而不是五支 curl（25 秒）、
                                                   為什麼四類只給條數、0 為什麼要印、
                                                   退路為什麼不印那四個 0、
                                                   以及 i18n 為什麼沒做
```

修改：
```
src/routes/memory.js                            — 新增 GET /hook-context?trigger=X。
                                                   一句 SQL 撈五類，team_standard 走
                                                   buildReadableWhere（跨帳號共用），
                                                   其餘四類留在 user_id 分支。
                                                   註冊在 /:id 之前，不會被吃掉。
shared/helpers.js                               — ruleMatchesTrigger 多一個
                                                   untaggedMatchesAll 選項。預設 true
                                                   （既有契約、鐵律照舊），
                                                   五類路徑傳 false。
shared/edit-reminder-state.js                   — 每小時視窗多帶 counts，
                                                   節流路徑才能照樣不打網路。
                                                   isEntry 不要求這個欄位，
                                                   舊的狀態檔還讀得起來。
hooks/ownmind-iron-rule-check.sh                — 改打 /hook-context，非 200 退回舊端點
                                                   並記 hook_context_fallback；
                                                   內嵌的 20 行渲染（含自己抄的 ALIASES）
                                                   換成呼叫 ownmind-render-context.js。
hooks/ownmind-iron-rule-check.js                — 改用 fetchHookContext，五類那行排在最前面。
hooks/ownmind-edit-reminder.js                  — 同上；自己那份 httpGet 移除。
install.sh / install.ps1                        — 掛勾檔清單補 ownmind-render-context.js
tests/iron-rule-check-response-shape.test.js    — 本來在 grep shell 檔裡的 parse 字串，
                                                   而那段搬家了。改成跑真的模組 ——
                                                   grep 得到卻永遠不執行的 parse，
                                                   測試照樣會綠。
tests/iron-rule-trigger-aliases.test.js         — 從「比對兩份 ALIASES 是否一致」
                                                   改成「斷言沒有第二份」。更強的保證。
tests/helpers/hook-home.js                      — HOOK_HELPERS 補 ownmind-render-context.js
tests/iron-rule-fetch-failure-logged.test.js    — stub 兩支端點都要失敗，否則新端點
                                                   回 200、測試綠著卻什麼都沒量
tests/iron-rule-hook-payload.test.js            — 「有沒有去查」改成兩支端點都算
tests/iron-rule-install-trigger.test.js
tests/edit-trigger-reminder.test.js
package.json                                    — 1.26.150 → 1.26.151
```

## v1.26.150 修改（兩份判斷變成一份 — issue #92 收尾）

新檔：
```
hooks/ownmind-detect-trigger.js                 — 從 stdin 讀指令、印出 trigger 名稱的包裝。
                                                   四行本體，判斷全在 detectCommandTrigger()。
                                                   走 stdin 不走 argv：commit 訊息常是多行，
                                                   stdin 沒有長度上限也沒有引號規則。
                                                   給了 argv 就用 argv，方便手動測，
                                                   也避免在沒接管線的終端機上卡住。
tests/helpers/hook-home.js                      — 幫 shell 掛勾搭拋棄式 $HOME 的唯一一處。
                                                   原本這段在五個測試檔各手抄一遍，
                                                   而掛勾一多一支 helper，四個檔八個測試同時紅、
                                                   全部同一個漏掉的連結。HOOK_HELPERS 那張表
                                                   就是為此存在：加 helper 只改這裡。
                                                   用 symlink 不用複製，改掛勾不必重搭；
                                                   node 從真實路徑解析模組，所以 hooks/package.json
                                                   的 "type": "module" 在 repo 裡就找得到，
                                                   假 $HOME 不需要複製一份。
openspec/changes/v1.26.150-one-classifier-not-two/
  proposal.md / spec.md / tasks.md               — 為什麼「shell 那份要能不靠 node」這個前提
                                                   其實早就不成立（第 23 行就在呼叫 node）、
                                                   為什麼因此選 B 案而不是 A 案、
                                                   為什麼不把判斷塞進現成那個 node 區塊、
                                                   以及安裝腳本那兩張清單為什麼是空轉的
```

修改：
```
hooks/ownmind-iron-rule-check.sh                — 20 行 grep 鏈刪掉，改成一行管線餵進
                                                   ownmind-detect-trigger.js。有檢查離開狀態、
                                                   非零寫 detect_trigger_failed 進活動記錄；
                                                   stderr 刻意不導掉（IR-002）——
                                                   安靜壞掉的判斷器回空答案，
                                                   跟「這條指令不觸發任何東西」長得一樣。
shared/helpers.js                               — detectCommandTrigger 的 KEEP IN SYNC 註記
                                                   改寫：已經沒有第二份要同步了。
                                                   樣式一條沒動，18 條指令答案全同 v1.26.149。
install.sh / install.ps1                        — 掛勾檔清單補 ownmind-detect-trigger.js。
                                                   註記標明這兩張清單在標準安裝下是空轉的
                                                   （OWNMIND_DIR 就是 $HOME/.ownmind，
                                                   來源與目的同一個檔，-ef 直接跳過），
                                                   真正把檔案放上去的是 git checkout。
tests/iron-rule-trigger-parity.test.js          — 標頭與失敗訊息改寫：現在守的是管線，
                                                   不是第二份規則表。表格保留 ——
                                                   包裝被拿掉、管線吃掉多行指令、
                                                   有人在 node 呼叫前面插捷徑，
                                                   從外面看都跟原本那個缺陷一模一樣。
tests/edit-trigger-reminder.test.js             — 改用 stageHookHome()
tests/iron-rule-fetch-failure-logged.test.js
tests/iron-rule-hook-payload.test.js
tests/iron-rule-install-trigger.test.js
package.json                                    — 1.26.149 → 1.26.150
```

## v1.26.149 修改（同一個判斷寫了兩份，而它們講的不一樣 — issue #92）

新檔：
```
tests/iron-rule-trigger-parity.test.js          — 18 條指令的對照表，同時餵給
                                                   detectCommandTrigger() 與真的那支 .sh 掛勾，
                                                   答案不同就紅。shell 那半是 spawn 真的掛勾、
                                                   再從它自己印的橫幅把 trigger 讀回來，
                                                   測試裡不重抄 grep 規則（重抄＝第三份副本）。
                                                   橫幅認不得就 throw，不回 null ——
                                                   回 null 會把每條指令都變成「沒判到」、
                                                   整個檔案照樣綠。也刻意不做「bash 找不到就跳過」
openspec/changes/v1.26.149-two-copies-that-answered-differently/
  proposal.md / spec.md / tasks.md               — 為什麼參考實作是 shared/helpers.js、
                                                   docker stack deploy 為什麼往上搬而不是刪掉、
                                                   del 為什麼不搬、以及 deploy/delete 順序
                                                   這一列為什麼是判斷而不是缺陷
```

修改：
```
hooks/ownmind-iron-rule-check.sh                — 觸發判斷鏈改成 detectCommandTrigger 的
                                                   逐條轉寫（連順序）。補 git tag、
                                                   docker compose build|push、Remove-Item；
                                                   docker.*up 換成明確樣式（本來會誤中
                                                   docker logs backup 的 backup）；
                                                   delete 分支移到 deploy 之後
shared/helpers.js                               — deploy 家族補 docker stack deploy（本來只有
                                                   .sh 認得）；detectCommandTrigger 補上
                                                   KEEP IN SYNC 註記並指名守門測試；
                                                   TRIGGER_TAG_ALIASES 的註記改成分清楚
                                                   「這張表有測試守」與「判斷邏輯本來沒有」
```

## v1.26.148 修改（提示句唸出你們公司自己「可以開口叫」的規範 — issue #85）

新檔：
```
shared/invocable-standards.js                   — 哪些團隊規範是「使用者可以開口叫」的。
                                                   INVOCATION_HINT_MAX（120 字，提示只有一行）、
                                                   validateInvocableMetadata（寫入時驗那一組欄位）、
                                                   buildInvocableStandards（從資料庫列建）、
                                                   hintsFromStandards（從 init 回應取句子）。
                                                   後兩支刻意分開：形狀不同而且搞錯是安靜的 ——
                                                   把回應清單餵給前者會回空陣列、提示默默退回靜態句
tests/invocable-standard-tips.test.js           — 30 tests：旗標沒台詞要擋 / 空白台詞 / 非布林旗標 /
                                                   超長與剛好等於上限 / 換行 / 非團隊規範不准標 /
                                                   沒提到這件事的記憶完全不受影響 / 從資料庫列建
                                                   （沒台詞的丟掉不退回唸標題、truthy 不等於 true、
                                                   重複句子去掉）/ 兩支函式不可互換（明確測）/
                                                   getRandomTip（沒標記時完全不變、400 抽內看得到公司
                                                   句子、靜態那句要退場、其餘池子還在、不連續重複）/
                                                   三處接線
```

改檔：
```
shared/tips.js                                  — getRandomTip 改收 { invocableHints }：有的話取代
                                                   靜態那句團隊規範提示（TEAM_STANDARD_TIP 由 anchor
                                                   找出來），沒有的話行為完全不變。不重複的記錄從
                                                   index 改成記文字，因為池子每次呼叫可能不同
src/routes/memory.js                            — init 回應新增 invocable_standards（compact 也送 ——
                                                   每個呼叫端都要 compact，只在非 compact 帶的欄位
                                                   等於沒人收得到）；POST / 與 PUT /:id 加上那一組
                                                   欄位的驗證，錯誤裡附上該怎麼寫
hooks/lib/render-session-context.js             — 開場那句提示改吃 init 回應裡的清單，不另外打 API
mcp/index.js                                    — init 時記下 currentInvocableHints，之後每一則回應的
                                                   提示都帶上；離線或沒 init 就是空陣列、退回原行為
tests/tip-every-call.test.js                    — 呼叫從無參數變成帶參數，斷言改成「有呼叫、而且不准
                                                   被條件包起來」，原本的「無條件帶上」意圖保留
mcp/offline.js                                  — 新增 readHookInitPayload：讀（不寫）開場掛勾那份
                                                   cache/memories.json，帶帳號指紋檢查與形狀檢查。
                                                   Claude Code 不會呼叫 ownmind_init，沒有這條路
                                                   每則回應的提示永遠拿不到清單
tests/cache-file-ownership.test.js              — 那條「MCP 不准提到 memories.json」改成管方向：
                                                   可以讀、不可以寫（writeMemoryCache 內不准出現
                                                   掛勾那個路徑），v1.26.137 要防的是兩個寫入者
tests/tips-list.test.js                         — 手冊那句措辭改了（提示可能來自帳號自己的規範），
                                                   斷言改成盯「散文 + 下一行渲染池子」的形狀
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md / CHANGELOG.md
                                                — 版號 1.26.148 與三語同步
openspec/changes/v1.26.148-a-tip-that-names-your-own-standards/
                                                — proposal / spec / tasks
```


## v1.26.147 修改（一條團隊規範，只有當初建立它的人改得動 — issue #85）

新檔：
```
src/utils/roles.js                              — ROLE_RANK / isAtLeast。從 middleware/adminAuth.js
                                                   搬出來，讓「誰能做什麼」的判斷可以比較角色位階、
                                                   而不用連帶 import auth middleware 跟資料庫連線池。
                                                   adminAuth.js 改成 import 進來再 re-export（不能直接
                                                   `export ... from`，它自己的守衛要用到這個名字）
src/utils/memory-write-access.js                — resolveWritableMemory：寫入權限的單一判定。
                                                   只用 id 撈那一列，再判斷「擁有者」或「共用型別 +
                                                   管理員」。查不到跟不能動回傳同一個 404，不能拿來
                                                   掃別人有哪些記憶。query 用注入的，本身不碰 db
tests/team-standard-admin-write.test.js         — 37 tests：擁有者（含 id 字串/數字對不上的情況）/
                                                   管理員對共用型別 / 管理員對私有型別要 404 且與
                                                   不存在無法區分 / super_admin 位階 / 一般成員讀得到
                                                   但寫不了 / 撈的時候不能帶 user_id / 五支 handler 都
                                                   改走 helper / UPDATE 要綁擁有者不是呼叫者（斷言前
                                                   先把註解拿掉，不然讀到的是解釋不是程式）/ 原本
                                                   跑不到的 admin 檢查還在、且新增到 enable 與 revert /
                                                   四種寫入都要留 admin_write
```

改檔：
```
src/routes/memory.js                            — PUT /:id、/:id/disable、/:id/enable、/:id/revert、
                                                   GET /:id/history 五支改走 resolveWritableMemory；
                                                   授權後的 UPDATE 綁那一列擁有者的 user_id；enable
                                                   與 revert 補上共用型別的 admin 檢查（本來沒有，
                                                   停用要管理員、啟用不用）；管理員代寫時把
                                                   admin_write { action, by_user_id, owner_user_id }
                                                   寫進 memory_history.metadata
src/middleware/adminAuth.js                     — ROLE_RANK / isAtLeast 移到 utils/roles.js，改成
                                                   import 後 re-export，既有呼叫端不用改
src/utils/memory-visibility.js                  — 檔頭更正：原本寫「更新與停用一律綁呼叫者自己的
                                                   user_id」，這一版之後不成立；改成指向
                                                   memory-write-access.js
tests/memory-visibility.test.js                 — 兩處對應更新：disable 的型別檢查來源改成
                                                   access.memory.type；「寫入未放寬」那一組改成斷言
                                                   「寫入仍然只打一位擁有者的那一列」（$5/$6），
                                                   並註明放寬的那半由 team-standard-admin-write 顧
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md / CHANGELOG.md
                                                — 版號 1.26.147 與三語同步
openspec/changes/v1.26.147-only-its-author-could-change-a-team-standard/
                                                — proposal / spec / tasks
```

## v1.26.144 修改（v1.26.139 修錯了：不是競態，是 fetch 拒絕某些埠號）

改檔：
```
tests/helpers/app-server.js                     — 新增 FETCH_BLOCKED_PORTS（fetch 規格的 82 個
                                                   封鎖埠號）與重抽邏輯：startServer 抽到清單上
                                                   的埠號就關掉重抽，上限 20 次，超過明確報錯。
                                                   被跳過的埠號放在回傳值的 rejectedPorts。
                                                   檔頭更正 v1.26.139 的錯誤診斷：失敗網址是
                                                   5060/5061/6000/6566，全是合法但被 fetch 拒絕
                                                   的埠號，跟 address() 競態無關。v1.26.139 加的
                                                   等待與位址檢查保留——解釋錯了，行為是對的
tests/test-server-helper.test.js                — 9 → 13 tests。新增：抽到封鎖埠號要重抽（用假
                                                   物件強制觸發那條路徑，不靠壓力探測的運氣）、
                                                   被拒的監聽器要關掉不能洩漏、封鎖清單必須含
                                                   實際量到的那四個埠號且不能含正常埠號（反向
                                                   控制，否則重抽是死碼）、全部被封鎖時要明確
                                                   報錯、以及直接對 undici 斷言那四個埠號真的
                                                   會被拒絕（前提本身也要驗，不能假設）
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md / CHANGELOG.md
                                                — 版號 1.26.143 與三語同步
```

## v1.26.141 修改（只有在你剛好講對詞的時候才答得出來的記憶）

新檔：
```
configs/ownmind-rules-block.md                  — 規則本文的唯一來源。會被注入使用者自己的
                                                   CLAUDE.md／AGENTS.md／GEMINI.md 等，
                                                   夾在 <!-- ownmind-rules --> 標記中間
scripts/install-helpers/sync-rules-block.cjs    — 標記區塊的唯一實作，四支安裝／升級腳本共用。
                                                   本來 shell 一份、PowerShell 一份，
                                                   v1.26.140 抓到兩份行為已經不一樣。
                                                   含舊區塊遷移：逐行比對是不是我們出貨過的內容，
                                                   有人手改過就留著並回報（IR-112）。
                                                   寫檔走 temp + rename，中斷不會截斷使用者的檔案
tests/sync-rules-block.test.js                  — 14 條。空檔案、檔案不存在、使用者自己的內容、
                                                   連跑兩次不變、兩個標記區塊並存、不累積空行、
                                                   中文原樣往返、沒有 BOM、不留暫存檔，
                                                   以及遷移的三種情況
tests/session-context-lookup-instructions.test.js
                                                — 27 條。開場內容必須告訴 AI「什麼時候該去查」，
                                                   不能只列已知的。含兩端覆蓋（掛勾版 + 給其他
                                                   AI 工具的操作手冊）。做過 mutation：把舊那句
                                                   撈全文的改回去死 3 條、拿掉「不認得就查」死 1 條、
                                                   拿掉「不准說沒有」死 2 條、拿掉伺服器那段死 3 條
```

修改檔：
```
hooks/lib/render-session-context.js             — 三句話。(1) 規範清單結尾那句從
                                                   ownmind_get("standard_detail") 改成先搜尋標題
                                                   再用 id 讀 —— 前者對「內文存在自己紀錄上」的
                                                   規範回傳空陣列，而那正是最近寫的那幾條。
                                                   (2) 碰到不認得的公司用語，回答或動手之前先搜尋。
                                                   (3) 對使用者自己的東西不准說「我沒有資料」，
                                                   除非這個 session 內真的查過 —— 那是一句關於
                                                   他的記憶的斷言
mcp/index.js                                    — 這一版真正送得到其他工具的地方。
                                                   ownmind_search 的說明改成寫「什麼時候該叫它」：
                                                   碰到不認得的公司用語先查、不准沒查過就說
                                                   「我沒有這個資料」。ownmind_get 的說明拿掉
                                                   「用 standard_detail 撈全文」——那句對內文存在
                                                   自己紀錄上的規範回傳空的，而工具說明每一輪都在
                                                   模型面前，本來就壓過開場那份
install.sh / install.ps1                        — CLAUDE.md 那段從「看到 OwnMind 就跳過」
                                                   （於是永遠不更新）改成呼叫共用腳本寫標記區塊
scripts/update.sh / scripts/update.ps1          — 新增 1c 段：每次升級把規則區塊寫進
                                                   CLAUDE.md 與另外六個工具的指示檔，
                                                   逐一計數、失敗點名
src/routes/memory.js                            — INSTRUCTIONS_SOP 新增「When to Read Memory」，
                                                   並修掉 Team Standard RAG 那段跟新規則打架的句子。
                                                   **注意：instructions 只有 compact=false 才送，
                                                   而每個呼叫端都帶 compact**——初稿只改這裡，
                                                   等於放在整包資料裡唯一沒人收得到的地方（review 抓到）
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md / CHANGELOG.md
                                                — 版號 1.26.141 與三語同步
```

## v1.26.140 修改（兩個都印了 OK 的失敗）

新檔：
```
scripts/windows/lib/append-upgrade-rule.ps1     — Add-OwnMindUpgradeRule：把升級規則寫進別的
                                                   AI 工具的指示檔。從 update.ps1 抽出來才測得到。
                                                   讀到 null（空檔案）一律當空字串——原本直接餵給
                                                   [regex]::Replace() 會炸，而且賦值沒完成，
                                                   下一行再對 null 呼叫 .TrimEnd()。
                                                   回 written / skipped，其餘一律丟例外讓呼叫端
                                                   自己交代。用 WriteAllText 寫（Set-Content
                                                   -Encoding UTF8 在 PS 5.1 會加 BOM，這些檔案
                                                   是別家工具在讀）
tests/append-upgrade-rule.test.js               — 7 條真的跑 PowerShell 的行為測試（空檔案、
                                                   檔案不存在、使用者自己的內容、連跑兩次、
                                                   中文原樣往返、工具沒安裝、沒有 BOM）
                                                   ＋ 靜態測試釘住兩個寫法不准搬回來。
                                                   跑的時候會照 update.ps1 一樣先開 StrictMode。
                                                   沒有 pwsh 的機器會標示原因跳過，不會假裝跑過
tests/update-sh-upgrade-rule.test.js            — 9 條。把 update.sh 的 1b 區塊從真正的腳本
                                                   抽出來跑（抄一份會走鐘），用假的 HOME 跟
                                                   一個必定失敗的 node 測「清除步驟跑不起來」。
                                                   做過 mutation：把 || true 加回去、把結尾換回
                                                   寫死字串、把失敗算成成功，三個突變都被抓到
```

修改檔：
```
scripts/update.ps1                              — 改用抽出來的輔助函式；六個目標逐一計數，
                                                   失敗的會被指名，結尾印實際數量而不是寫死的
                                                   「[ OK ] synced」——就是那行固定字串讓這個錯誤
                                                   看起來像成功。輔助檔不在（不完整的 checkout）
                                                   會出一行警告，而不是整段安靜跳過
scripts/update.sh                               — 同一件事的 mac / Linux / Git Bash 版：結尾印
                                                   實際數量、清除步驟不再掛 `|| true`（掛著的話
                                                   node 跑不起來會變成「舊區塊留著 + 又加一個新的」
                                                   而畫面照樣說成功）
scripts/windows/lib/append-upgrade-rule.ps1     — 讀檔改用 [System.IO.File]::ReadAllText。
                                                   Get-Content -Raw 在 PowerShell 5.1 讀沒有 BOM
                                                   的檔案會用系統編碼（繁中 Windows 是 cp950），
                                                   而這支程式寫的就是沒有 BOM 的 UTF-8——
                                                   下一次更新會把使用者自己的中文當 Big5 解、
                                                   弄壞再寫回去
src/lib/llm-narrative.js                        — callLLMSwitch 會重試：408 / 429 / 5xx 跟連線
                                                   直接失敗重兩次、間隔三秒、總共 60 秒為限，
                                                   而且每次嘗試的逾時被這個期限夾住（否則三次
                                                   卡死要等九十秒）；4xx 一次就回報。錯誤訊息帶
                                                   實際用掉幾次嘗試。上游回應留 2,000 字而不是
                                                   200 字——查上一次那個 502 得從伺服器手動重放
                                                   請求，因為紀錄剛好斷在第二、三個供應商失敗
                                                   的原因那裡
src/lib/narrative-condense.js                   — 更正 v1.26.137 寫下的「閘道有 40 KiB 硬上限」。
                                                   那次的探測內容是同一句短句重複貼的，每位元組
                                                   耗的 token 遠少於真實報告，所以二分法找到的
                                                   邊界不是位元組的邊界。實測：40,214 位元組過得去，
                                                   而 35,301 位元組被擋，同一份二十分鐘後六次全過。
                                                   精簡買的是機率不是保證，註解照實改
src/routes/me-narrative.js                      — 同上，註解改成量到的事實
tests/llm-narrative.test.js                     — 17 條重試測試。做過 mutation：拿掉 429、
                                                   預設不重試、上游訊息砍回 200 字、拿掉嘗試次數、
                                                   什麼狀態都重試，五個突變全部被抓到。
                                                   逾時那條改成用真的會理會 signal 的 fetch——
                                                   原本自己造一個 AbortError，而真正的
                                                   DOMException 的 message 是唯讀的，
                                                   那條測試綠著放過了一個會毀掉錯誤訊息的
                                                   TypeError
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md / CHANGELOG.md
                                                — 版號 1.26.140 與三語同步
```

## v1.26.139 修改（每次跑測試都有紅字，每次紅的都不是同一個）

新檔：
```
tests/helpers/app-server.js                     — startServer(app)：等 'listening' 才讀位址、
                                                   檢查位址可用（不可用就報實際看到什麼，
                                                   不拿 undefined 去組網址）、接 listen 的
                                                   'error' 事件（原本沒接會變成毫無資訊的
                                                   「測試超時」）、close() 先
                                                   closeAllConnections 再關（否則 fetch 留下
                                                   的長連線會讓回呼不觸發）
tests/test-server-helper.test.js                — 9 tests：網址一定帶真實埠號、位址不可用要
                                                   報錯而不是回一個壞網址（含 port 0）、
                                                   listen 出錯要浮上來而不是掛到超時、
                                                   close 會 resolve；並釘住那四支實際紅過的
                                                   測試不准回頭自己開 listen(0)
```

改檔：
```
tests/login-rate-limit.test.js                  — 改成整支共用一台伺服器。原本每個請求開關
                                                   一台，並行跑全套時 address() 回不出可用
                                                   位址，埠號以 undefined 進網址，失敗訊息是
                                                   bad port，看起來像頻率限制壞了
tests/stage-1b-flip-root-retire-me.test.js      — 同上，改成整支共用一台
tests/selfcheck-endpoint.test.js                — 每個測試各自建 app，所以維持一個請求一台，
                                                   但改走 startServer（原本在 listen(0) 的
                                                   下一行就同步讀 address()）
tests/self-check-memory-load.test.js            — 同上
scripts/update.sh                               — 掛勾同步從只複製 *.sh 擴大到 *.js 與 *.cjs
                                                   （~/.claude/hooks 底下的 .js 副本原本會
                                                   停在舊版；選擇同步而不是刪除，因為夠舊的
                                                   安裝可能真的指向那裡）。lib/ 複製的
                                                   2>/dev/null || true 改成失敗就明說
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md / CHANGELOG.md
                                                — 版號 1.26.139 與三語同步
```

## v1.26.138 修改（開場的記憶載入變成空的，而且回報 ok）

新檔：
```
tests/cache-file-ownership.test.js              — 8 tests：兩個寫入者不准共用快取路徑
                                                   （含反向控制：兩邊一起搬到新的共用路徑
                                                   不算通過）、holdsInitPayload 要認出單數
                                                   型別鍵、複數形的 init 回應仍要被接受
                                                   （否則每次開場都重新下載）、以及最關鍵
                                                   的一項：帳號標記正確、sync_token 新鮮、
                                                   時間沒過期，只有形狀不對的快取必須被
                                                   當成不存在
```

改檔：
```
mcp/offline.js                                  — 離線快取改用自己的檔案
                                                   cache/mcp-memories.json。原本跟開場程式
                                                   的 conditional-sync 共用 memories.json，
                                                   兩者結構不同：開場程式存 init 回應原形、
                                                   記憶服務存按型別分類。開場程式只要看到
                                                   sync_token 對得上就直接把 cache.data
                                                   當成 init 內容，於是渲染出空橫幅
hooks/lib/conditional-sync.js                   — readCache 新增 holdsInitPayload 守門：
                                                   拿到不是 init 形狀的內容就當成不存在。
                                                   這一層不依賴上面那層，已經被寫壞的機器
                                                   下一次開場會自己痊癒，不用手動刪檔。
                                                   判別用否定式（單數型別鍵），因為肯定式
                                                   得指名一個每個帳號都保證有的欄位，而
                                                   空帳號幾乎沒有這種欄位
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md / CHANGELOG.md
                                                — 版號 1.26.138 與三語同步
```

## v1.26.137 修改（那頁只有 7 天看得到分析）

新檔：
```
src/lib/narrative-condense.js                    — 送給模型之前把資料縮到額度內。一步一步做、
                                                    每步重量一次、一放得下就停，所以 7 天原封不動。
                                                    順序照資訊密度：截長文 → 丟掉「全部遵守」的規則
                                                    → 版本每台收一列（留最舊的，因為這區是看誰沒更新）
                                                    → 最後手段從最大的那區裁。精簡了什麼會寫進資料裡，
                                                    讓模型知道自己讀的是摘要
tests/narrative-condense.test.js                 — 13 條測試。重點不是「有沒有變小」，是「變小之後
                                                    留下的還有沒有用」：每個有踩坑的專案都還在、有違反
                                                    的規則一條都沒少、落後的版本沒被新版蓋掉、連跑兩次
                                                    不會愈削愈薄
```

```
tests/fixtures/narrative-7d.json                 — 一份真實 7 天報表的形狀（自由文字換成等長替身、
                                                    名字換掉）。用來釘住「一直正常的那個區間不會被
                                                    精簡」；只比對常數的話，資料多長一欄就會失守
```

修改檔：
```
src/routes/me-narrative.js                       — 送出前先過精簡；回覆帶上「哪幾區被摘要了」；
                                                    壓不下去時記下還剩幾位元組（上次查這個問題是把
                                                    請求搬到伺服器手動重放才看到原因）
src/lib/llm-narrative.js                         — 把組請求的那段抽成 buildRequestBody()，量大小跟
                                                    真正送出去的用同一支程式產生，否則量了等於沒量。
                                                    指示新增第 10 條：看到摘要標記就要先講清楚自己
                                                    看到的是哪一部分，禁止推斷整體比例
client/src/pages/Portal/NarrativePage.jsx        — 把「哪些被摘要了」顯示在報告最上面。不顯示的話，
                                                    讀者會看到 AI 說明跟旁邊的完整統計表對不起來，
                                                    而不知道為什麼
client/src/i18n/{zh,en,ja}.json                  — 對應的三語文案
tests/me-narrative.test.js                       — 3 條路由層測試：真正送到模型的大小在上限之下、
                                                    回覆有說哪些被摘要、本來就放得下的區間完全不動
```

## v1.26.136 修改（打錯網址回「伺服器壞了」）

新檔：
```
src/utils/row-id.js                              — 編號驗證：只有純數字、1 以上、不超過資料庫
                                                    整數上限的才算編號。比 parseInt 嚴格是刻意的，
                                                    parseInt('12abc') 會得到 12，等於讓打錯的網址
                                                    安靜讀出別人的第 12 筆。命名不綁記憶，因為交接
                                                    那組路由也用它
tests/row-id.test.js                             — 8 條測試：正常編號、帶雜訊的數字、0 與負數、
                                                    空值、超過整數上限、非純量型別
tests/e2e/route-ids.spec.mjs                     — 12 個情境，打真的伺服器＋真的資料庫。這支才是
                                                    測到真正壞掉那件事的：壞的不是數字判斷，是路由
                                                    登記順序，而那只有發出請求才驗得到。含「檢查要
                                                    排在身分驗證之後」跟「正常編號仍然拿得到」
```

修改檔：
```
src/routes/memory.js                             — 在路由層統一掛一道編號檢查（router.param），
                                                    不是六條各寫一次；之後新增吃編號的路由也不會
                                                    忘記。打錯的網址現在回 404 而不是 500。另外
                                                    「還原舊版本」從請求內容帶進來的版本編號也擋掉
src/routes/handoff.js                            — 同一道檢查。那邊沒有被蓋住的固定路徑，所以沒有
                                                    真的端點在壞，但 /api/handoff/abc/accept 一樣
                                                    會回 500
```

## v1.26.135 修改（稽核表二十五萬筆，沒有一筆是真的）

新檔：
```
db/024_usage_audit_unknown_model_once.sql        — 只管「不認識的模型」這一類的部分唯一索引，
                                                    鍵是 (tool, details->>'model')。它是應用層
                                                    去重擋不住的那個空窗的後盾：兩份上傳同時
                                                    帶著同一個新模型時，兩邊都會先讀到「還沒
                                                    記過」。其他類型的稽核本來就該每則訊息一
                                                    筆，索引刻意不涵蓋它們。建索引之前先收斂
                                                    既有重複值（每組留最早那一筆），否則還留
                                                    著舊資料的資料庫會開不了機。用的是
                                                    「min(id) 以外全刪」而不是兩兩自我比對，
                                                    後者在二十五萬筆六種模型上跑超過四分鐘
```

修改檔：
```
src/routes/usage/events.js                       — 新增 lookupReportedUnknownModels()：寫之前
                                                    先問這張表哪些模型已經記過。同一批裡同一
                                                    個模型只由第一則訊息去記，而且是在確定寫
                                                    進去的那一刻才認領（不然開頭是重送的那一
                                                    批會把名額吃掉）。稽核寫入加上撞到就安靜
                                                    放掉、並指定要看哪一道索引，讓競爭中輸的
                                                    那邊不要去記一筆「寫入失敗」。另外抽出
                                                    splitKey()：查詢用的鍵是 tool::值 字串，
                                                    只切第一個分隔符，模型名稱或工作階段代號
                                                    自己帶著 :: 時才不會被切錯半邊
tests/ingestion.test.js                          — 8 條新測試：同一個模型只記一次而不是每則
                                                    訊息一次、已經記過的模型不再記、一批裡不
                                                    同的新模型各記一筆、token 倒退仍然維持每
                                                    則訊息一筆（防止這條規則擴散到其他類型）、
                                                    開頭是重送的那一批不能把名額吃掉、整批都
                                                    是重送、查詢讀到過期資料因而真的去撞索引、
                                                    以及模型名稱自己帶著 :: 時不會被切錯。假
                                                    的資料庫模擬那道唯一索引，並額外數「嘗試
                                                    寫入幾次」——只數表裡有幾筆的話，索引會
                                                    一個人扛完所有斷言，去重整段刪掉也不會紅
## v1.26.134 修改（安裝腳本印「已更新」的依據是意圖，不是檔案）

改檔：
```
install.ps1                                     — 金鑰寫進 settings.json 之後讀回來、解析、
                                                   比對，對不上就明說「金鑰不在檔案裡」；對得上
                                                   才印原本三句並補「verified by reading it
                                                   back」。四個寫入點的 ConvertTo-Json 從
                                                   -Depth 10 改 100（超過深度只警告不報錯，
                                                   會把分支寫成 System.Collections.Hashtable
                                                   這個字串）。完成橫幅移到自我檢查之後，
                                                   包自我檢查的空 catch 補上訊息
install.sh                                      — 同上的讀回來確認（node -e 區塊內），對不上
                                                   印 PROBLEM。完成橫幅整塊移到產出檢查與
                                                   自我檢查之後——原本會在「complete」底下印出
                                                   「[FAIL] Installation did not complete.」
tests/installer-key-update.test.js              — 13 → 18 tests：兩支都要讀回來確認、都要有
                                                   金鑰沒落地的訊息、深度不准退回 10、橫幅必須
                                                   排在檢查之後、自我檢查爆掉要說話。既有的
                                                   「真的執行 install.sh 抽出區塊」測試改成
                                                   斷言 verified by reading it back，那句話
                                                   只有走完比對分支才印得出來
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md / CHANGELOG.md
                                                — 版號 1.26.134 與三語同步
```

## v1.26.133 修改（三個只在 Windows 出現、都不會自己報錯的缺陷）

新檔：
```
hooks/lib/pending-banners.js                    — 待顯示訊息佇列的解析規則，一個地方。
                                                   parsePendingBanners（壞掉的行不能拖累讀得懂
                                                   的行；解析成功但沒帶 block 的紀錄也算讀不出
                                                   來，否則整份都是這種的佇列會長得跟空佇列
                                                   一樣，然後被刪掉）、renderPendingBanners
                                                   （沒東西就回空字串——那既是「不要印孤零零
                                                   的標題」，也是呼叫端「不要清檔」的訊號）
shared/init-cache.js                            — 精簡 init 回應可以拿來寫什麼、不能拿來寫
                                                   什麼。pickRulesForCache（回應有帶就用、
                                                   沒帶就用另外抓的、兩邊都沒有就回 null，
                                                   呼叫端不准寫；真的空陣列照寫，因為「這個
                                                   帳號沒有可快取的規則」跟「查不到」必須
                                                   分得開）、mergeOfflineCacheData（回應沒
                                                   回答的型別保留舊快取）、
                                                   previousDataForAccount（合併才需要問的
                                                   問題：磁碟上那份是誰的。沿用 v1.26.82
                                                   的帳號指紋，沒有標記就當成別人的）、
                                                   OFFLINE_CACHE_FIELDS（型別對應欄位，
                                                   新增型別不會在其中一邊無聲消失）
tests/pending-banners.test.js                   — 12 tests：解析與算繪的行為，加上兩個端到端
                                                   ——真的把掛勾跑起來，斷言那一則訊息確實
                                                   出現在 stderr 且佇列被清空；以及完全讀不出
                                                   東西的佇列要被搬到 .unreadable 而不是刪掉。
                                                   另有原始碼層的守門：不准再把佇列餵給
                                                   看不到輸出的子行程，清空必須排在寫出之後
tests/init-cache.test.js                        — 17 tests：含 mutation control（證明修改前的
                                                   `data.iron_rules || []` 真的會把快取清空）、
                                                   每個快取型別都要被覆蓋到、以及一個端到端：
                                                   真的啟動一個 MCP 行程去打一台只回精簡回應的
                                                   假伺服器，斷言快取裡的規則還在
tests/scheduler-actions-home-marker.test.js     — 9 tests：expandHomeMarker 的行為、mutation
                                                   control（不還原的話健康的排程就是會被判成
                                                   別人的）、反向控制（還原之後別人的排程仍然
                                                   不是我們的），並直接對 safeSpawn 斷言它真的
                                                   會把家目錄換成 ~——那是這整份測試的前提
```

改檔：
```
hooks/ownmind-session-start.js                  — drainSpools 的橫幅那段改成呼叫新的
                                                   flushPendingBannerFile：當場自己印，
                                                   印出去了才清檔，讀不出東西的佇列搬到
                                                   .unreadable。runLibScript 的 stdinFile
                                                   參數直接移除——一個三條輸出全部 ignore
                                                   的執行器，不該提供把資料餵給「會產生
                                                   輸出的程式」的入口
hooks/lib/flush-pending-banners.js              — 改成共用 pending-banners.js 的解析規則。
                                                   這支 CLI 留給 shell 掛勾（它自己沒辦法
                                                   解析 jsonl）；Node 掛勾不再經過它
mcp/index.js                                    — init 的兩處快取寫入。鐵律快取改成先看回應
                                                   有沒有帶陣列，沒帶就去問
                                                   /api/memory/type/iron_rule，兩邊都失敗就
                                                   不動快取。離線快取改成 mergeOfflineCacheData
                                                   （合併而不是覆蓋），精簡回應沒帶的型別
                                                   保留舊值，並寫入 account 指紋、只在指紋
                                                   相符時才沿用舊資料
scripts/install-helpers/scheduler-task-owner.cjs — 新增 expandHomeMarker(text, home)：把
                                                   safeSpawn 代換掉的 ~ 還原成家目錄，只認
                                                   緊接路徑分隔符的那種。刻意不併進
                                                   taskBelongsToInstall——所有權規則有兩份
                                                   實作彼此對賭，而只有 JS 這邊會經過消毒
                                                   函式，還原是呼叫端的問題
scripts/install-helpers/self-check.cjs          — checkScheduler 在問所有權之前先還原家目錄，
                                                   用的是跟 OWNMIND_DIR 同一個 HOME
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md / CHANGELOG.md
                                                — 版號 1.26.133 與三語同步
```

## v1.26.132 修改（為了安裝而寫的鐵律，在安裝時不會出現）

新檔：
```
tests/iron-rule-install-trigger.test.js         — 17 tests：install/setup/bootstrap/update
                                                   四種腳本檔名與 API_KEY／credential 都要
                                                   歸成 install 類、npm install 與 pip
                                                   install 一定不能中（每次裝套件都跳的提醒
                                                   等於沒有提醒）、既有 commit/deploy/delete
                                                   分類不受影響，以及把 .sh 掛勾真的跑起來：
                                                   `bash install.sh --api-key` 要連到規則
                                                   API、要點名 IR-001 與 IR-002、且不能把
                                                   一條 trigger:delete 的規則拖進來
tests/iron-rule-fetch-failure-logged.test.js    — 4 tests：規則端點回 500／401 都要在活動
                                                   紀錄留下 iron_rule_fetch_failed 並寫明
                                                   原因與觸發類別；成功查詢不准留失敗紀錄
                                                   （「沒有規則符合」不是失敗）；失敗永遠
                                                   不准出現在 stdout，也不准擋下指令
```

改檔：
```
shared/helpers.js                               — detectCommandTrigger 新增 install 判定，
                                                   放在所有既有判定之後，既有分類不變。
                                                   金鑰樣式改守「前面不是英文字母」而不是
                                                   \b：底線是單字字元，\bAPI_KEY\b 抓不到
                                                   OWNMIND_API_KEY —— 唯一抓不到的形狀剛好
                                                   是唯一會出現的形狀。
                                                   TRIGGER_TAG_ALIASES 加 install（收
                                                   install/setup/config/安裝/設定/api_key/
                                                   credential_rotation/換金鑰/切換帳號），
                                                   刻意不收 script 與 debug。
                                                   detectTriggerFromContext（MCP
                                                   report_compliance 的入口）同樣補上
                                                   install，否則就是在另一個入口重建
                                                   這一版要關掉的落差
hooks/ownmind-iron-rule-check.sh                — TRIGGER 偵測與內嵌 ALIASES 同步上面兩處
                                                   （KEEP IN SYNC 註解已標）。取鐵律的
                                                   curl -sf ... 2>/dev/null 三重消音拆掉：
                                                   body 進暫存檔、狀態碼進變數，失敗走
                                                   log_event 而不是 stdout；node 的 stderr
                                                   不再倒掉（IR-002）；逾時 3 秒 → 5 秒
```

## v1.26.131 修改（更新不了的機器，也說不出自己更新不了）

新檔：
```
tests/mcp-log-event-windows-home.test.js         — 11 tests：沒有 HOME 時路徑仍是絕對路徑
                                                    （Windows 的情況）、USERPROFILE 優先於
                                                    空字串、原始碼不准再出現 `HOME || ''`、
                                                    四種更新結果都要立刻送，以及兩條真的跑起來
                                                    的實測：資料夾不能寫的時候事件仍然要送到
                                                    伺服器（純比字串的版本擋不住這個 bug，
                                                    因為原本出錯的是建資料夾、不是寫檔），
                                                    還有一筆序列化不了的事件不准把排隊中的
                                                    其他事件一起帶走
```

修改檔：
```
mcp/ownmind-log.js                               — 路徑改用 HOME || USERPROFILE ||
                                                    os.homedir()（Windows 沒有 HOME、`|| ''`
                                                    會讓它變成相對路徑）；改成先排隊上傳、
                                                    再寫本機檔，寫檔有自己的 try，而建資料夾
                                                    只在那個 try 裡面呼叫（原本它是整段的第一
                                                    行，出錯會連上傳一起跳過、而且安靜）；
                                                    序列化提前做，壞掉的一筆不會拖垮整批；
                                                    建資料夾的記憶改成記路徑而不是記布林；
                                                    update_applied / failed / skipped / clean
                                                    改成立刻送出，不進緩衝區
scripts/install-helpers/ensure-pretooluse-hooks.cjs — 同一個寫法的另外三處一起改掉。目前
scripts/install-helpers/add-post-tool-use-hook.cjs    呼叫端都有帶參數、碰不到，但這一版的
scripts/install-helpers/add-stop-hook.cjs             前提就是這個寫法會一再出現
```

## v1.26.130 修改（看得到、修不到：修復端問的問題比檢測端弱）

新檔：
```
scripts/install-helpers/schedule-health.ps1      — 新增、Windows 排程健康判斷的唯一一份規則
                                                    （Test-ScheduleHealthy /
                                                    Test-TaskBelongsToInstall /
                                                    Get-TaskActionText）。純字串邏輯、不碰
                                                    Task Scheduler，所以測試在 macOS / Linux
                                                    也執行得到。讀 actions 的那支也放這裡：
                                                    它一旦回空字串，全部歸屬判斷都會退回
                                                    「無法判斷」，閘門就變回修之前那樣而測試
                                                    全綠
tests/scanner-schedule-ownership.test.js         — 26 tests：同一張案例表跑 JS 與 PowerShell
                                                    兩份實作（含 Adam 那台的真實 actions 字串）、
                                                    停用/讀不到狀態仍算壞掉、多個 action 不能
                                                    只讀第一個、修復前的閘門與修復後的驗證都要
                                                    問歸屬且要真的中斷、三邊算出同一個安裝目錄
```

修改檔：
```
scripts/install-helpers/ensure-scanner-schedule.ps1 — 健康閘門從「有工作而且沒被停用」改成
                                                    Test-ScheduleHealthy；重新註冊完也確認
                                                    工作真的指回這個安裝目錄，失敗時把它實際
                                                    指到哪裡寫進訊息。安裝目錄改成跟註冊端、
                                                    自我檢測端算同一個值（拿掉 OWNMIND_DIR
                                                    覆寫，否則修復永遠不會收斂）；旁邊的檔案
                                                    改用 $PSScriptRoot 找
scripts/install-helpers/self-check.cjs           — 查排程補上 -TaskPath '\'，跟修復端問同一
                                                    個問題
FILELIST.md / CHANGELOG.md / package.json        — 版號與紀錄
```

## v1.26.129 修改（副本執行少了 shared/ ＋ 自動更新不再靜悄悄）

新檔：
```
shared/update-banner.js                          — 新增、背景更新結果的訊息文案 + 排進
                                                    banner-pending.jsonl（下次開對話印出來）。
                                                    成功講版號、失敗講白話步驟並問要不要回報、
                                                    沒有新版就什麼都不寫（沉默要繼續代表沒事）
hooks/lib/queue-update-banner.js                 — 新增、給 shell updater 用的 CLI 殼。
                                                    applied 不帶版號時自己讀 package.json
                                                    （讀取必須發生在 pull 之後）
tests/update-banner.test.js                      — 12 tests：成功/失敗文案、未知步驟不吞掉、
                                                    無新版不寫、版號讀不到就不寫（「已更新到 ? 版」
                                                    比沉默還糟）、多行訊息不能拆成兩行 JSON、
                                                    append 不覆蓋、目錄不存在會自己建、寫不進去回 false
tests/hook-lib-resolution.test.js                — 5 tests：LIB_DIR 優先指工作目錄、沒有任何呼叫點
                                                    還用 $SCRIPT_DIR/lib、被呼叫的模組都存在，
                                                    以及照真實環境重建的反向測試（複製到沒有
                                                    shared/ 的資料夾會 ERR_MODULE_NOT_FOUND）
tests/upgrade-reminder-threshold.test.js         — 7 tests：落後一版/幾版不吵、落後夠多才提醒、
                                                    邊界釘死、新 minor 的早期 patch 只提醒舊 minor、
                                                    文案講的是「更新壞了」不是「有新版」。
                                                    比對用的是 broadcast-filter 真的在用的
                                                    isHigher，不是自己重寫一份
tests/session-context-field-coverage.test.js     — 5 tests：init 回的每個欄位都必須被算繪、
                                                    列為「不該進 session 開場」並寫理由，
                                                    或列進已知缺口（目前 5 個，只能減不能增）。
                                                    新增欄位而沒人處理就會紅
```

修改檔：
```
hooks/ownmind-session-start.sh                   — 7 個 lib 呼叫點全部改走 LIB_DIR
                                                    （優先 $OWNMIND_DIR/hooks/lib，因為 shared/
                                                    在它旁邊）。這修掉 v1.26.127 會讓記憶完全
                                                    載不進來的問題，也修掉 conditional-sync
                                                    一直載入失敗、退化成「API 慢」的老問題。
                                                    另外每個更新結果分支都排一則 banner
src/jobs/nightly-upgrade-reminder.js             — 門檻從「不是最新版就提醒」改成落後
                                                    LAG_PATCHES(10) 版以上；標題改成
                                                    「自動更新好像沒在運作」；文案附回報出路。
                                                    每次執行先把自己取代掉的舊自動廣播收掉
                                                    （它們從來沒寫 ends_at、後台又不准撤銷
                                                    is_auto，只改門檻等於沒改）
mcp/index.js                                     — 更新成功/失敗都排一則 banner。MCP 跟 bash
                                                    hook 搶同一把鎖、誰先搶到誰做，只接一支
                                                    等於擲骰子
hooks/ownmind-session-start.js                   — 同上（這支是 Windows 上真正在做更新的那支）
tests/broadcast.test.js                          — 既有的 4 個 stub 補上新的 UPDATE 分支
```

## v1.26.128 修改（團隊規範送到了 hook 面前、然後被丟掉）

修改檔：
```
hooks/lib/render-session-context.js              — 算繪 team_standards_digest。init 一直都有回它，
                                                    而且放在 !compact 外面（＝專門為 hook 這條路送的），
                                                    但這支從來沒讀。結果團隊規範只到得了會呼叫
                                                    ownmind_init 的工具，到不了走 SessionStart hook 的
                                                    ——Claude Code 整個在後者。排在鐵律後面（衝突時
                                                    鐵律優先，用順序講），並附 standard_detail 的讀法
                                                    （摘要只有標題，看得到名字讀不到內容還是遵守不了）
tests/session-start-render.test.js               — 新增 4 條：摘要有算繪、有指出怎麼讀全文、
                                                    沒有團隊規範時整段不出現、順序排在鐵律之後
shared/tips.js                                   — 兩句技巧文案依 Vin 決定回到原本寫法
                                                    （回報 bug 直接送管理者、團隊規範自動遵守）。
                                                    後者現在是送得到的，靠的跟鐵律同一個東西
```

## v1.26.127 修改（技巧清單合一，每條綁一個真的存在的東西）

新檔：
```
shared/tips.js                                   — 新增、技巧的唯一來源，25 條（原本 28）。
                                                    每條是 { text, anchor }，
                                                    anchor 是 mcp/index.js 真的有註冊的工具名，
                                                    或 file:<路徑>（單一工具涵蓋不到的能力）。
                                                    另外提供 getRandomTip（不連續重複）與
                                                    renderTipPool（給操作手冊內插）
tests/tips-list.test.js                          — 24 tests：每條錨點都解得出來、沒有重複技巧、
                                                    getRandomTip 只回清單裡的字且不連續重複、
                                                    mcp/index.js 不准再有自己的 TIPS、
                                                    操作手冊必須內插而不是重寫、
                                                    任何技巧原文出現在 shared/tips.js 以外就紅、
                                                    五份範本「每一行」都要說沿用 Tip 且不可自行編造
```

修改檔：
```
hooks/lib/render-session-context.js              — SessionStart 內容補一句 Tip。技巧本來只掛在
                                                    MCP 工具回應上，但用 hook 載入記憶不是一次
                                                    工具呼叫 —— 範本要 AI 在啟動後印一句技巧，
                                                    那條路上從來沒人給它一句，模型就自己補。
                                                    這是「技巧跟 OwnMind 無關」的真正來源
mcp/index.js                                     — 刪掉自己的 TIPS（28 條）跟 getRandomTip，
                                                    改 import ../shared/tips.js
src/routes/memory.js                             — INSTRUCTIONS_SOP 的 tip pool 改成
                                                    ${renderTipPool()}，不再把 28 條重寫一遍。
                                                    原本兩份一字不差、沒有任何程式在比對
configs/AGENTS.md                                — 兩處技巧位置改成「沿用工具回應裡已附的那句 Tip、
                                                    不可自行編造」
configs/GEMINI.md                                — 同上（一處）
configs/global_rules.md                          — 同上。註：Windsurf 是安裝時 cp 一份過去、
                                                    已存在就跳過，舊安裝不會跟著更新
configs/copilot-instructions.md                  — 同上
configs/antigravity.md                           — 同上
tests/changelog-feed.test.js                     — 原本釘死「第二筆是 1.26.125」，下一版就會紅、
                                                    而且紅的理由跟它要防的 bug 無關。改成整份清單
                                                    的版號不准往上爬（允許相等 — v1.26.98 有六筆）
```

（`configs/CLAUDE.md` 沒有技巧提示指令，這版也沒有加 — Claude Code 一直都不自己加技巧。）

## v1.26.126 修改（頁尾更新紀錄接上 CHANGELOG.md）

新檔：
```
src/utils/changelog.js                           — 新增、把 CHANGELOG.md 解析成 entries。
                                                    三種標題寫法都認（破折號 / ASCII 連字號 /
                                                    日期在前），只認第一種會讓 284 筆沒有標題。
                                                    摘要取第一段散文，跳過圍籬區塊、遇 ### 停。
                                                    圍籬區塊裡的 ## 不算標題（整份檔案有六個引用式標題，
                                                    含本版自己的範例區塊）。
                                                    loadChangelogEntries 讀不到檔案回 []、不丟例外
src/routes/changelog.js                          — 新增、GET /api/changelog 回 { entries }，
                                                    factory 形式掛在 auth 後面（比照 createVersionRouter）。
                                                    模組載入時解析一次：CHANGELOG.md 不會在同一個 process 內變
client/src/hooks/useChangelog.js                 — 新增、走 apiGet('/api/changelog')，初值 []、
                                                    失敗維持 []（等同原本的空狀態）。模組層級快取、只快取成功值。
                                                    **只能從 Layout 呼叫**，理由同 useServerVersion
tests/changelog-feed.test.js                     — 27 tests：三種標題寫法、圍籬區塊裡的標題不算、
                                                    無版號的標題要跳過、（同版）標記要拿掉、
                                                    摘要跳過程式碼區塊／小標／表格／清單、
                                                    inline markdown 清乾淨、
                                                    真實 CHANGELOG.md 的第一筆等於 package.json 版號、
                                                    第二筆是前一版（引用式標題的回歸守門）、
                                                    每一筆都有標題、版號不唯一（所以 React key 是複合的）、
                                                    路由回傳與 auth 卡控、Dockerfile 有 COPY CHANGELOG.md（IR-034）
```

修改檔：
```
.dockerignore                                    — 加 !CHANGELOG.md。清單裡有 *.md，
                                                    少了這行 re-include 不是「檔案沒進映像」，
                                                    是 build 直接失敗（failed to compute cache key）
Dockerfile                                       — 加 COPY CHANGELOG.md。src/ 跟 db/ 是逐個 COPY 的，
                                                    放在它們之外的檔案不會進映像，而解析失敗會安靜退成 []
tests/dockerfile-runtime-files.test.js           — 新增一條通用守門：每一行從 build context 來的 COPY，
                                                    來源都不能被 .dockerignore 排除（--from= 的不算）。
                                                    原本「Dockerfile 裡有那行 COPY」的斷言在 build
                                                    壞掉的狀態下照樣是綠的
tests/dashboard-version-source.test.js           — 新增 6 條：Layout 有呼叫 useChangelog、
                                                    App 不再宣告 changelog、hook 只有一個呼叫者、
                                                    hook 走 apiGet 且失敗不進快取、
                                                    Footer 與三個語系都不再有 footer.copyright
src/app.js                                       — 掛上 /api/changelog
client/src/App.jsx                               — 拿掉 layoutProps = { changelog: [] }，
                                                    <Layout {...layoutProps}> 改回 <Layout>
client/src/components/common/Layout.jsx          — 自己呼叫 useChangelog()，不再從 App 收 prop
client/src/components/common/Footer.jsx          — 版號顯示補 v 前綴（跟頁尾左側同一個寫法）、
                                                    date 空字串就不畫那個 <span>、
                                                    React key 改成「版號 + 位置」（版號不唯一，
                                                    v1.26.98 底下有六筆）、
                                                    拿掉右下角 footer.copyright（Vin 要求）
client/src/i18n/{zh,en,ja}.json                  — 三個語系一起刪 footer.copyright，不留孤兒鍵
```

## v1.26.125 修改（擋對了但名字寫錯）

新檔：
```
tests/secret-vendor-attribution.test.js         — 8 條。回報的廠商必須等於實際命中的前綴。
                                                   含 mutation control（證明修復前的
                                                   sk- 樣式真的會吃掉 Anthropic 金鑰）、
                                                   兩條反向控制（sk-proj- 與經典 sk- 仍報
                                                   OpenAI）、以及 sk-antelope… 仍是 OpenAI
                                                   的邊界案例。素材一律執行時組合，不寫成
                                                   單一字串 —— 否則此檔會被它所測試的掃描器
                                                   擋住，上一版已經發生過
```

修改檔：
```
shared/secret-detect.js                         — 新增 anthropic_api_key 規則
                                                   /sk-ant-[A-Za-z0-9_-]{20,}/，排在
                                                   openai_api_key 之前（迴圈第一個命中即回傳）；
                                                   openai_api_key 改為 /sk-(?!ant-)…/，獨立
                                                   拒絕 Anthropic 前綴。兩道防護並存，讓重排
                                                   順序或單改一條都不足以恢復誤標
```

文件：
```
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.26.124 → 1.26.125
CHANGELOG.md / FILELIST.md                                          — 本版紀錄
```

未改動（先查證過）：
```
tests/pre-commit-secret.test.js                 — 5 處 regex:openai_api_key 斷言，素材皆為
                                                   sk-proj-…（確實是 OpenAI），不受影響
tests/secret-detect-unit.test.js                — 1 處同上
```

## v1.26.124 修改（四道防線裡有兩道從來沒擋過任何東西）

新檔：
```
shared/local-date.js                            — localDateOnly / localIsoTimestamp。「今天」的
                                                   單一定義，四個檔案共用。標頭記錄了實測到的
                                                   三方不一致：shell 掛勾 08-10、MCP 08-10、
                                                   Node 掛勾 08-09，同一時刻
shared/cacheable-rules.js                       — isCacheableRule / filterCacheableRules。
                                                   規則快取收「任一消費者需要的」：帶
                                                   verification（commit 引擎）或帶
                                                   lint_validator（Stop 掛勾）。兩個寫入者共用，
                                                   否則誰後寫誰決定對方看得到什麼
scripts/install-helpers/scheduler-task-owner.cjs — taskBelongsToInstall()。排程任務是不是這次
                                                   安裝建的。純函式、零相依，所以不在 Windows
                                                   也測得到；讀不到 actions 視為「無法判斷」

tests/local-date-agreement.test.js              — 12 條。本地日期規則、shell 與 JS 一致性、
                                                   東經時區的反向控制、四個共用日誌目錄的程式
                                                   不得再用 UTC 算日期的守門測試
tests/pre-commit-secret-baseline.test.js        — 8 條。用修復前真實重現的那段外洩內容，逐一
                                                   涵蓋三個曾經靜默放行的出口；三條反向控制
                                                   （乾淨程式碼、空 staging、名字嚇人但內容是
                                                   散文）確保修法不會退化成「什麼都擋」
tests/cacheable-rules.test.js                   — 12 條。含 mutation control：證明舊的
                                                   verification-only 過濾真的會讓驗證器消失
tests/windows-scanner-schedule.test.js          — 11 條。install.sh 的 Windows 分支 + 排程歸屬
                                                   判斷。兩者都寫成任何平台都能跑
```

修改檔：
```
hooks/ownmind-git-pre-commit.js                 — 金鑰掃描移到所有鐵律出口之前（step 0）；
                                                   secretGuardReported 讓有 secret-guard 鐵律
                                                   時 baseline 退場、不重複報告；迴圈後補上
                                                   backstop；bypassSet 上移，OWNMIND_BYPASS=all
                                                   與 BASELINE 仍放行並寫稽核列；快取寫入改用
                                                   filterCacheableRules
hooks/ownmind-session-start.js                  — 日誌檔名、時間戳、.last-update-check 全部改用
                                                   本地日期
hooks/ownmind-reply-lint.js                     — spoolEvents 的檔名改用本地日期；localDateOnly
                                                   走 main() 內受保護的動態 import（規格只允許
                                                   Node 內建做靜態 import）
mcp/index.js                                    — runAutoUpdate 的「今天」改用本地日期；兩處
                                                   快取寫入改用 filterCacheableRules
mcp/ownmind-log.js                              — localDateOnly 改為從 shared/ 再匯出，既有
                                                   匯入者不受影響
install.sh                                      — 排程 case 補 msys*|cygwin*|win32*) 分支：呼叫
                                                   register-scanner-task.ps1、帶
                                                   -ExecutionPolicy Bypass、註冊後回頭確認任務
                                                   存在、全程不丟棄 stderr（IR-002）
scripts/install-helpers/self-check.cjs          — 排程檢查一併讀 actions，經
                                                   taskBelongsToInstall 確認屬於這次安裝

tests/reply-lint-hook-v197.test.js              — 日誌檔名改用共用的 localDateOnly（原本用 UTC，
                                                   正是本版修掉的表達式）
```

文件：
```
package.json / README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.26.123 → 1.26.124
CHANGELOG.md / FILELIST.md                                          — 本版紀錄
```

## v1.26.122 修改（讓整套測試在 Windows 上跑不完的那個檔案）

修改檔：
```
tests/update-lock-mutual-exclusion.test.js      — import() 全部改用 pathToFileURL(...).href
                                                   （8 處：3 處子行程、5 處行程內）。絕對路徑
                                                   在 Windows 上開頭是磁碟機代號，ESM loader
                                                   讀成 URL scheme 而拒絕 —— 跟 v1.26.108 在
                                                   mcp/index.js 修過的同一個錯。
                                                   contender 的 stderr 從 ignore 改成 pipe
                                                   並且真的去讀（只 pipe 不讀，管線塞滿之後
                                                   子行程會卡在寫入不結束，等於把診斷變成它
                                                   要解釋的那個當機）。race() 在沒人獲勝時
                                                   先印出第一個 contender 的 stderr
tests/migration-017-bug-reports-id-serial.test.js
                                                — 去註解前先切掉 \r。CRLF 檢出時每行結尾都是
                                                   \r，而 \r 對 JS 正規表達式是行結束字元，
                                                   `.` 不會跨過去 —— `--.*$` 因此一個字都沒剪，
                                                   測試把自己的說明註解當成 SQL 讀
README.md / docs/README.zh-TW.md / docs/README.ja.md
                                                — 目前版本 v1.26.122
package.json                                    — 1.26.121 → 1.26.122
```

## v1.26.121 修改（自己弄壞的兩條 ＋ 一條擋不住 Windows 的守門測試）

修改檔：
```
README.md / docs/README.zh-TW.md / docs/README.ja.md
                                                — 開頭的「目前版本」補到 v1.26.121
                                                   （117–120 連續四版漏改）
hooks/lib/sync-memory-files.js                  — 註解裡的真實家目錄路徑改成 placeholder
hooks/ownmind-iron-rule-check.sh                — 註解引用的個人鐵律編號改成描述規則本身
tests/no-personal-rule-codes.test.js            — 白名單比對前先正規化分隔符。原本寫
                                                   src/routes/me.js，而 path.relative 在
                                                   Windows 上回 src
outesme.js，那個唯一
                                                   有正當理由的例外從來沒被比對到
package.json                                    — 1.26.120 → 1.26.121
```

## v1.26.120 修改（半安裝的機器上鐵律檢查整個沒在跑，#79 的 A 組）

修改檔：
```
hooks/ownmind-iron-rule-check.sh                — settings.json 的路徑改用 argv 傳給
                                                   node（process.argv[1]），不再插進
                                                   node -e 的原始碼。path-helpers.sh
                                                   不在時 fallback 原封不動回傳，Windows
                                                   上就是反斜線路徑 → JS parser 當成跳脫
                                                   序列 → 讀檔失敗 → 空金鑰 → 靜靜 exit 0。
                                                   同時拿掉憑證讀取的兩個 2>/dev/null
                                                   （IR-002），讀不到的理由要進 stderr
tests/iron-rule-hook-payload.test.js            — 不再 child.stderr.resume() 把 stderr
                                                   倒掉（IR-003）；失敗訊息附 exit code、
                                                   stdout、stderr。原本的訊息是猜的，
                                                   而且猜錯了
tests/edit-trigger-reminder.test.js             — 「狀態目錄不可寫」改成拿普通檔案擋在
                                                   資料夾的位置（POSIX ENOTDIR／Windows
                                                   ENOENT），chmod 0o500 在 NTFS 上是
                                                   空操作，製造不出不可寫的目錄
tests/node-hook-parity.test.js                  — 清理改成重試＋失敗時在 stderr 說一聲。
                                                   掛勾會啟動更新腳本，子行程可能比它多活
                                                   一下，Windows 不准刪還開著的資料夾，
                                                   於是斷言全過之後才因 EPERM 失敗，還掛
                                                   在一個無關的測試名字上
package.json                                    — 1.26.119 → 1.26.120
```

## v1.26.123 修改（Windows 剩下的 9 條紅燈：測試自己站錯磁碟機）

新增檔：
```
tests/helpers/unwritable-path.js                 — makeUnwritablePath()：拿一個「檔案擋在
                                                   資料夾該在的位置」當不可寫路徑。三個平台
                                                   都失敗（ENOTDIR，Windows 也認），而且東西
                                                   建在 temp 底下。原本用的 /root/no-permission
                                                   在 Windows 上是普通目錄，直接建起來寫成功
tests/bash-path-list.test.js                     — bashPathList／toWinPath 的正向＋反向對照，
                                                   外加一條真的到「另一顆磁碟機」上跑的：
                                                   轉換過的找得到、原始寫法找不到。只有一顆
                                                   硬碟的機器會明講自己跳過，不假裝有覆蓋
tests/lint-zh-only-crlf.test.js                  — 註解裡的黑名單字在 LF／CRLF 都要被忽略，
                                                   反向對照：不在註解裡的同一個字兩種換行
                                                   都必須照樣抓到（否則「修好」可能只是
                                                   把 lint 關掉）
```

修改檔：
```
scripts/lint-zh-only.js                          — split(/\r?\n/)，不是 split('\n')。CRLF
                                                   checkout 下每行尾巴留著 \r，而 \r 對 JS
                                                   regex 是行結束字元，`.` 不跨過去，所以
                                                   /\/\/.*$/ 一個都比不到、註解剝除整個沒作用。
                                                   npm test 第一步就是這支 lint，於是 Windows
                                                   上整套測試停在這裡。和 v1.26.122 在
                                                   migration-017 修的是同一個 \r
tests/helpers/bash-script.js                     — 新增 bashPathList()（PATH 用冒號分隔，而
                                                   Windows 路徑裡就有一個；切出來的後半段是
                                                   相對於磁碟機根目錄的路徑）與 toWinPath()
                                                   （to_win_path 的 JS 對應，由 bash-path-list
                                                   跑真的 shell 函式比對，防止兩邊漂移）
tests/hook-log-event-details.test.js             — 假 curl 的 bin 走 bashPathList，LOG_DIR 與
tests/run-scanner-wrapper.test.js                  capture 走 toBashPath；wrapper 那兩行漏掉的
                                                   PATH 補上（同檔其他地方早就轉了）
tests/installer-key-update.test.js               — $CLAUDE_SETTINGS_WIN 換成 toWinPath 的結果，
                                                   也就是 install.sh 真正填進去的形狀
tests/lint-event-logger.test.js                  — 改用 makeUnwritablePath；session-counter
tests/session-counter.test.js                      兩條原本只斷言「不可以 throw」，寫成功也算過，
tests/session-counter-block.test.js                現在額外斷言那個檔案真的沒被寫出來
tests/post-commit-version-reminder.test.js       — 子行程同時設 HOME 與 USERPROFILE。hook 走
                                                   os.homedir()，Windows 讀的是 USERPROFILE
tests/pre-commit-secret.test.js                  — 冒號檔名那兩條在 Windows 明講理由 skip
                                                   （NTFS 非法字元，建不出來），補上 [ab].txt
                                                   兩條：[ab] 對 git pathspec 是字元集合、
                                                   字面檔名配不到自己，而中括號 NTFS 收
README.md / docs/README.zh-TW.md                 — 版本標記 1.26.122 → 1.26.123
docs/README.ja.md / package.json
```

## v1.26.119 修改（記憶檔在 Windows 上從來沒寫成功過，#79 的 C 組）

新增檔：
```
tests/helpers/posix-path.js                     — toPosix / relPosix：在「路徑變成斷言」
                                                   的那個點正規化成正斜線。走訪檔案的測試
                                                   在 Windows 上會拿到 src\app.js，跟
                                                   'src/app.js' 這種字面值比對就紅了 ——
                                                   找對了檔案、比錯了分隔符
```

修改檔：
```
hooks/lib/sync-memory-files.js                  — projectSlugFromPath 也要換掉冒號。
                                                   Windows 專案路徑開頭是 C:\，而冒號在
                                                   資料夾名稱裡非法（NTFS 讀成 ADS 分隔符），
                                                   所以 mkdir 失敗（實測 ENOENT）、SessionStart hook
                                                   在 Windows 上從來沒寫成功過任何記憶檔。
                                                   C:\Users\Vin\X → C--Users-Vin-X，正是
                                                   Claude Code 自己的專案資料夾拼法
shared/scanners/sqlite-cli.js                   — databaseExists 收可注入的 access，讓
                                                   「只有 ENOENT 算不存在」這條規則不必靠
                                                   變出真的 OS 錯誤就測得到（Windows 把
                                                   ENOTDIR 那個形狀也回成 ENOENT）
tests/scanner-vscode-multipath.test.js          — 新增直接測那條規則的案例；真實 OS 的
                                                   ENOTDIR 案例留在 POSIX，Windows 改成
                                                   斷言「這裡真的是 ENOENT」，哪天變了會紅
tests/bare-mount-trailing-slash.test.js         — 走訪結果過 toPosix
tests/dashboard-version-source.test.js          — relative → relPosix（四處）
tests/add-post-tool-use-hook.test.js            — 假家目錄依平台造，期待值用同樣的
tests/add-stop-hook.test.js                       path.join 造，並直接斷言 path.isAbsolute
package.json                                    — 1.26.118 → 1.26.119
```

## v1.26.118 修改（「可執行」這個斷言在 Windows 上不可能成立，#79 的 B 組）

新增檔：
```
tests/helpers/executable-bit.js                 — assertExecutable(repoRoot, relPath)：
                                                   問 git index 的 mode（100755），三個平台
                                                   都讀得到，而且它決定的是每台 clone 的
                                                   機器會拿到什麼；POSIX 上再額外驗本機
                                                   那個位元。chmod 在 NTFS 上是空操作
                                                   （實測 755 讀回來是 666）
tests/executable-bit-helper.test.js             — 這把新尺自己的正向＋反向對照：拿一個
                                                   commit 成 100644 的檔案餵進去必須紅，
                                                   否則「Windows 上會過」跟「餵什麼都會過」
                                                   分不出來
```

修改檔：
```
tests/bootstrap-script.test.js                  — bootstrap.sh 的可執行斷言改走 index mode
tests/run-migrations.test.js                    — run-migrations.sh 同上
tests/shebang-eol.test.js                       — 複製 git hook 那條驗的是暫存目錄裡的新檔，
                                                   沒有 index 可以問；Windows 上改成斷言
                                                   install_git_hook 有去要 chmod +x，
                                                   真正的觀測留在有意義的平台
package.json                                    — 1.26.117 → 1.26.118
```

## v1.26.117 修改（自我檢查只確認「有登記」，從來沒確認「叫得起來」）

新增檔：
```
scripts/install-helpers/mcp-preflight.cjs       — 把 ~/.claude.json 裡的 command/args/env
                                                   原封不動 spawn 起來，走完 JSON-RPC
                                                   handshake（initialize →
                                                   notifications/initialized → tools/list）
                                                   並數 ownmind_* 工具。回傳
                                                   status: ok / fail / unknown ——
                                                   逾時是 unknown（fail-open，理由見
                                                   CHANGELOG）。所有離開這支模組的字串都
                                                   先過 redactor：env 裡帶 KEY/TOKEN/
                                                   SECRET/PASSWORD 的值換成 ***、家目錄
                                                   換成 ~，因為結果會寫進 log 並上傳。
                                                   Windows 上登記的指令是 cmd.exe /c
                                                   start.cmd，殺 shell 不會殺底下的 node，
                                                   所以收尾走 taskkill /T /F。
                                                   也可以單獨跑：node mcp-preflight.cjs
                                                   [--home=...] [--timeout=ms]，印 JSON
tests/mcp-preflight.test.js                     — 17 條，全部不需要 Windows、也不需要裝好的
                                                   OwnMind：用暫存目錄裡的假 MCP server
                                                   跑正常／指令不存在／起來就死／起得來但
                                                   沒有 ownmind_* 工具／逾時／只回一半。
                                                   含金鑰不外洩（正向＋反向對照）、逾時後
                                                   server 不會留在背景、以及 self-check
                                                   的狀態對應（unknown 一定是 warn）
```

修改檔：
```
scripts/install-helpers/self-check.cjs          — 新增 mcp_launches 檢查項，排在
                                                   mcp_registered 後面（前者讀檔、永遠有
                                                   答案；後者回答它答不了的那一半）。
                                                   MCP_PREFLIGHT_TIMEOUT_MS = 20000（TANK
                                                   實測 693ms，預算刻意寬鬆，理由同
                                                   CIM_TIMEOUT_MS）。checkMcpLaunches 的
                                                   preflight 可注入，狀態對應才測得到。
                                                   另補 checkNamesFor：mcp_registered 從
                                                   v1.26.112 起就在跑卻從沒被宣告，等於對
                                                   「宣告了卻沒跑」那條測試是隱形的
mcp/index.js                                    — sendMcpHeartbeat() 看到
                                                   OWNMIND_PREFLIGHT=1 就直接 return。
                                                   mcp_launches 是診斷用的啟動，不是一次
                                                   使用；照原樣啟動會讓 collector-silence
                                                   看到的 heartbeat 天天更新，等於替一台
                                                   沒人在用的機器背書
package.json                                    — 1.26.116 → 1.26.117
```

## v1.26.116 修改（Windows 上，那個報告明明寫了檔名，檢查卻說它沒寫）

修改檔：
```
tests/hung-test-is-named.test.js                — 「報告有沒有寫出這個檔案」的比對改成看
                                                   最後兩段（每次執行都不同的暫存資料夾＋
                                                   檔名），反斜線正規化、忽略大小寫。
                                                   Windows 上 TAP 會把反斜線跳脫、而
                                                   os.tmpdir() 回的是 8.3 短檔名，兩者都
                                                   會讓整串比對失敗。新增 4 條用 Windows
                                                   真實拼法當 fixture 的測試（含反向對照），
                                                   在 Mac 上就跑得到。失敗訊息現在會附上
                                                   報告內容，因為這條只會在我不在的平台上紅
package.json                                    — 1.26.115 → 1.26.116
```

## v1.26.115 修改（上一版那條新測試，自己在 Windows 上是紅的）

修改檔：
```
tests/hung-test-is-named.test.js                — 探針的工作目錄不再是等一下要刪掉的那個
                                                   暫存資料夾（Windows 不准刪還被佔著的
                                                   資料夾）；殺探針的每一條路徑都等到
                                                   process 真的結束，含 5 秒保險，原本
                                                   Windows 走的 fallback 沒等就往下走；
                                                   刪除本身改成會重試，因為 handle 在
                                                   process 被回收之後還會多留一下
package.json                                    — 1.26.114 → 1.26.115
```

## v1.26.114 修改（測試卡住的時候，它什麼都不說）

新增檔：
```
tests/hung-test-is-named.test.js                — 3 條。兩條盯著設定：每個會跑 node --test
                                                   的 npm 腳本都要帶時限（腳本清單是長出來
                                                   的、不是手寫的），而且值要落在「不會誤殺
                                                   正常跑的測試」跟「趕得及在 CI job 自己的
                                                   時限之前開火」之間 —— 上限是從 workflow
                                                   的 timeout-minutes 讀出來的，不是再抄一份。
                                                   第三條是陽性對照：真的做一個會卡住的測試檔
                                                   丟進去跑，要求時限把它結束掉並且回報名字。
                                                   對照會先量「這個 node 版本上哪一種形狀
                                                   真的會卡」，一種都不卡就直接紅，因為那時
                                                   它什麼都沒量到。反向驗證：同一個檔案不帶
                                                   時限跑，時間到了必須還活著。探針用 detached
                                                   起、整個 process group 一起殺，否則被殺的
                                                   只有執行器、真正跑檔案的孫程序會活下來
openspec/changes/v1.26.114-a-hung-run-says-nothing/
                                                — proposal / spec / tasks
```

修改檔：
```
package.json                                    — test 跟 test:watch 都加
                                                   --test-timeout=300000；
                                                   1.26.113 → 1.26.114
.github/workflows/test.yml                      — 在 npm test 那一步旁邊寫下為什麼要帶時限，
                                                   免得下一個人把它當雜訊刪掉
```

## v1.26.113 修改（那個假的 stat 測不到四件事，而失敗還是沒有聲音）

修改檔：
```
hooks/ownmind-session-start.sh                  — lock_age_seconds 兩種寫法都答不出來時，
                                                   改成往 stderr 講清楚是哪個檔案、兩種
                                                   寫法都試過了，再 return 非零。原本只是
                                                   默默回非零 —— 而「失敗沒有聲音」正是
                                                   這個缺陷能活九個版本的原因。呼叫端行為
                                                   不變、一樣 fail-closed。方言處理的邏輯
                                                   一個字都沒動
tests/update-lock-mutual-exclusion.test.js      — 補 4 條 v1.26.111 那兩條射程外的案例：
                                                   ①不帶 stub、直接問這台機器真正的 stat
                                                   （那正是 Linux 上答「不能」而 macOS 上
                                                   全綠的那題）；②走完整條路，20 分鐘前的
                                                   lock 必須真的被 acquire_update_lock
                                                   接管，而不只是 lock_age_seconds 回對；
                                                   ③兩種寫法都壞時 stderr 要講原因；
                                                   ④檔案不存在時兩個 stream 都要安靜，
                                                   否則 ③ 的診斷會對著幾乎每次 session
                                                   都不存在的 .reclaim 噴
package.json                                    — 1.26.112 → 1.26.113（排在 #77 之後，
                                                   兩個 PR 原本都編 v1.26.112、撞號）
```

## v1.26.112 修改（MCP server 從來沒被註冊在 Claude Code 會讀的那個檔案）

新增檔：
```
scripts/install-helpers/register-mcp.cjs        — 唯一一份 MCP 註冊實作，四支腳本共用
                                                   （install.sh / install.ps1 /
                                                   update.sh / update.ps1），避免再各寫
                                                   一份然後漂掉。同時寫 ~/.claude.json
                                                   （Claude Code 真正啟動 MCP 的地方）
                                                   跟 ~/.claude/settings.json（本專案
                                                   resolveCredentials 先看的地方）。
                                                   原子寫入、合併而非覆蓋、讀不懂的設定
                                                   檔直接拋錯不動它（那個檔案裝著使用者
                                                   全部的專案歷史），寫完再讀回來驗證，
                                                   家目錄必須是絕對路徑、Windows 上不收
                                                   POSIX 路徑
scripts/install-helpers/register-mcp-cli.cjs    — 上面那支的命令列入口，四支腳本都透過它
                                                   呼叫。存在的理由：`node -e "<script>"`
                                                   在 PowerShell 5.1 下活不下來 —— 它會把
                                                   傳給原生執行檔的參數裡的雙引號拿掉，
                                                   三行探針實測印出三個 NaN，因為
                                                   console.log("x=" + argv[1]) 變成
                                                   console.log(x=+argv[1])。改傳 JSON 也
                                                   一樣被拆掉。所以現在每個值各自一個
                                                   argv 元素，會跨越 shell 的只剩路徑跟
                                                   網址裡本來就有的字元。同一家族的 bug：
                                                   v1.26.94
tests/mcp-registered-where-claude-reads.test.js — 16 條。含反向對照（只寫 settings.json
                                                   的舊行為必須被判定為未註冊）、不得動到
                                                   os.homedir()、不得弄壞既有的 projects
                                                   歷史、四支腳本都必須真的呼叫 helper、
                                                   兩支升級腳本必須傳 home 給
                                                   resolveCredentials、self-check 必須
                                                   有在跑這項檢查
```

修改檔：
```
install.sh / install.ps1                        — Claude Code MCP 區塊改成呼叫共用 helper，
                                                   並且回報「讀回來確認過」而不是回報
                                                   「我寫了」
scripts/update.sh / scripts/update.ps1          — 新增 3.0b 節。沒有人會重跑安裝腳本，
                                                   自動更新走 git pull → npm install →
                                                   update.*，只修安裝腳本等於只有新使用者
                                                   受惠、既有機器原封不動壞著（v1.26.104
                                                   在 git hook wrapper 上踩過同一個坑）。
                                                   沿用機器上既有的啟動指令與金鑰，沒憑證
                                                   就安靜跳過，寫不進去就明講工具不會出現
scripts/install-helpers/self-check.cjs          — 新增 mcp_registered。mcp_files 確認檔案
                                                   在、mcp_node_modules 確認跑得起來，
                                                   而決定它會不會被啟動的那個檔案，原本
                                                   沒有任何一項在看
docs/setup-claude-code.md                       — 原本教使用者寫 ~/.claude/settings.json，
                                                   那個檔案對 MCP 沒有作用。改成
                                                   ~/.claude.json，並列表說明兩者差別
package.json                                    — 1.26.111 → 1.26.112
```

## v1.26.111 修改（stat -f 在 Linux 上不是安靜地失敗）

修改檔：
```
shared/update-lock.js                           — 清掉遺留的 reclaim 標記時，移開之後回頭確認
                                                   移走的真的是過期的那一份。贏得 rename 不等於
                                                   移走的是剛才量到的那一份 —— 中間可能有人放了
                                                   一份新鮮的回去，於是兩個 process 同時進臨界區
hooks/ownmind-session-start.sh                  — 上面那件事的 shell 版（兩邊必須一致）。另外
                                                   lock_age_seconds 不再假設 `stat -f %m`
                                                   會安靜地失敗。-f 在 BSD 是格式字串、在 GNU
                                                   是 --file-system，所以 Linux 上它會先把
                                                   五行檔案系統資訊吐到 stdout 才回非零，
                                                   `||` 再把正確的時間接在後面 —— 變數變成
                                                   一團垃圾，下一行算術直接 syntax error。
                                                   兩種寫法各跑一次、各自檢查是不是純數字
tests/update-lock-mutual-exclusion.test.js      — 上面那件事的兩條測試。用假的 stat 放進
                                                   PATH，所以在 macOS 上也跑得到 —— 重點正是
                                                   這是一個在 Mac 上看不見的缺陷。另一條是
                                                   鏡像案例：只有 BSD 寫法能用時也要算得出來
openspec/changes/v1.26.107-ci-first-day/        — 這一版跟 v1.26.107 的發版文件寫在同一個
                                                   change 目錄（那一版合併時缺文件，一起補）
package.json                                    — 1.26.110 → 1.26.111
```

## v1.26.107 修改（這個 repo 開始有 CI 了）

新增檔：
```
.github/workflows/test.yml                      — push 到 main、任何 PR、手動都會跑。
                                                   必過：ubuntu × node 20、ubuntu × node 24、
                                                   macOS × node 20。只顯示不擋：windows ×
                                                   node 20（獨立 job + continue-on-error，
                                                   不是 matrix leg —— 那樣的 leg 在
                                                   needs.<job>.result 仍然回報 failure，
                                                   gate job 分不出「只有 Windows 紅」跟
                                                   「全部都紅」）。步驟是 npm ci →
                                                   ensure-console-build → npm test，
                                                   不需要資料庫
openspec/changes/v1.26.107-ci-first-day/        — proposal / spec / tasks
```

修改檔：
```
tests/install-failed-beacon-ps1.test.js         — 從真實腳本**遞迴**抽出相依函式，不再只抽
                                                   function Fail（Fail 內插的
                                                   Get-LastLogLines 沒被帶進去，PowerShell
                                                   在組參數時就丟例外、被 Fail 自己的
                                                   catch {} 吞掉）。找不到 pwsh 時退回
                                                   PowerShell 5.1 —— 那正是 install.ps1
                                                   實際呼叫的那一支。斷言改成驗 throw 本身
                                                   （catch 裡 exit 3），不再用 exit 1，
                                                   因為「丟了例外被收掉」跟「腳本自己垮了」
                                                   都是 1
tests/scanner-schedule-repair.test.js           — 兩個 plist 案例不再只靠 plutil（macOS 專屬，
                                                   其他平台一律 ENOENT，等於哪裡都沒跑）。
                                                   直接檢查產生出來的 XML；plutil 在的時候
                                                   仍然照跑當交叉驗證。預期路徑改成只比對真正
                                                   要驗的那一段，不再拿 Git Bash 的 /tmp/… 跟
                                                   node 的 C:\Users\…\Temp\… 互比
（版號在這一版沒有動：v1.26.107 已經出去了，這裡補的是當時缺的發版文件）
```

## v1.26.106 修改（四個只在 Windows 上壞、而 Mac 測不到的問題）

新增檔：
```
scripts/install-helpers/read-text-file.cjs      — 依 BOM 解碼，不猜。PowerShell 的每一種
                                                   寫法都會留 BOM，所以 BOM 是可靠的依據。
                                                   另含 stripNul / stripNulEscapes ——
                                                   JSON.stringify 會把 NUL 轉成跳脫序列，
                                                   而 Postgres 抱怨的正是那個跳脫序列
tests/windows-log-encoding.test.js              — 20 條。編碼是位元組的性質，所以 fixture
                                                   就是位元組 —— 不需要 Windows 也測得到。
                                                   含審查抓到的那個案例：內容本來就寫著那六個
                                                   字元時，不可以剪
tests/windows-test-hygiene.test.js              — 288 條（隨掃描到的檔案數量增長）。掃描原始碼
                                                   本身：沒有裸的 .pathname、每個會執行腳本的
                                                   PowerShell spawn 都帶 -ExecutionPolicy
                                                   Bypass、.cmd stub 有跳脫 cmd.exe 中繼字元、
                                                   兩支查 Task Scheduler 的函式都用加大後的預算。
                                                   掃描範圍含 hooks / mcp / scripts / shared /
                                                   src，不只 tests —— 第一版只掃 tests，而同一
                                                   個毛病當時正活在出貨的掛勾裡
openspec/changes/v1.26.106-windows-only-and-mac-cannot-see-it/ — proposal / spec / tasks
```

修改檔：
```
install.ps1                                     — 註冊排程的輸出不再走 `| Tee-Object
                                                   -FilePath`。Windows PowerShell 5.1 的
                                                   Tee-Object 沒有 -Encoding 參數（PS 6 才
                                                   加），所以它一定寫 UTF-16LE —— 那台機器上
                                                   每一個 register-task-*.log 都是 fffe 開頭，
                                                   最早一個是 2026-05-09。改用 Write-Utf8NoBom，
                                                   螢幕輸出用 Write-Host 補回，$LASTEXITCODE
                                                   在下一行就讀
scripts/install-helpers/self-check.cjs          — 讀 log 改走 readTextFileSync（依 BOM 解碼）；
                                                   CIM_TIMEOUT_MS 5000 → 30000（Get-ScheduledTask
                                                   是 CIM cmdlet，閒置 Windows 10 實測約 1.5 秒，
                                                   而 self-check 跑的時機正是安裝升級剛結束、
                                                   機器最忙的那一刻）；新增 describeSpawnFailure
                                                   保留 killed／signal 證據，不再把 timeout 回報成
                                                   「Requires Windows + PowerShell」；上傳與 spool
                                                   收斂到單一 serializeReport
tests/git-bash-detection.test.js                — PowerShell spawn 補上 -ExecutionPolicy Bypass
                                                   （出貨的呼叫端全都有帶，只有測試漏了；沒設定過
                                                   原則的 Windows 用戶端預設 Restricted，
                                                   dot-source .ps1 直接被擋）。.cmd stub 補上
                                                   cmd.exe 中繼字元跳脫 —— 真實 bash --version
                                                   第三行結尾是 <http://gnu.org/licenses/gpl.html>，
                                                   cmd 把 < 讀成輸入重導向
tests/install-artifacts.test.js                 — new URL().pathname → fileURLToPath。Windows 上
                                                   前者產出 /C:/Users/...，node 再接到當前磁碟根
                                                   目錄變成 C:\C:\...，整個 process 在第一個斷言
                                                   之前就死掉。另外「stat 不到的路徑」不再用
                                                   chmod(0o000)（NTFS 上是 no-op），改成把目錄換成
                                                   檔案讓 stat 因 ENOTDIR 失敗 —— 每個平台都同意
                                                   的理由，順便不再需要 root 的特例分支
tests/installer-node-paths.test.js              — 同上的 fileURLToPath。另外「沒有 cygpath」不再
                                                   用 PATH=/usr/bin:/bin 表示 —— Git Bash 的
                                                   cygpath 就住在 /usr/bin，前提在 Windows 上是假的。
                                                   改成清空 PATH
tests/session-log-args.test.js                  — fileURLToPath
tests/source-files-are-text.test.js             — fileURLToPath
hooks/ownmind-git-commit-msg.js                 — 改用 fileURLToPath 找自己的目錄。原本是裸的
                                                   new URL(...).pathname，在 Windows 上會變成
                                                   C:\C:\...，底下的 import 全部解不開；而這支
                                                   掛勾設計上任何異常都 exit 0，所以結果不是報錯，
                                                   是**每一條 commit 訊息規則在 Windows 上靜靜地
                                                   沒在跑**（審查抓到）
tests/install-failed-beacon-ps1.test.js         — spawn PowerShell 補上 -ExecutionPolicy
                                                   Bypass（審查抓到；它用 PWSH 常數，所以躲過了
                                                   hygiene 測試原本的挑檔條件）
package.json                                    — 1.26.105 → 1.26.106
```

## v1.26.105 修改（同一個設定檔裡，一個掛勾在跑，一個死了四個月）

新增檔：
```
scripts/install-helpers/ensure-pretooluse-hooks.cjs — PreToolUse 鐵律掛勾的註冊／修復，
                                                   四支安裝升級腳本共用同一份。指令
                                                   **不一樣就改寫**，不再把「這個 matcher
                                                   底下有提到 ownmind-iron-rule-check」
                                                   當成「它是對的」—— 壞掉的那筆自己滿足
                                                   了自己的修復條件，所以 v1.26.92 只修到
                                                   全新安裝，升級戶一個都沒修到。
                                                   --bash / --node 對應兩種呼叫寫法
scripts/update.sh / scripts/update.ps1          — 自我檢查（self-check.cjs）從第 2d 節搬到腳本
                                                   最後面。原本排在所有修復動作前面，回報的是
                                                   這支腳本正要修掉的狀態 —— 一台機器發一次
                                                   警報，等有人看的時候它已經好了。install.sh
                                                   的安裝自檢本來就在最後一行
tests/ensure-pretooluse-hooks.test.js           — 22 條行為測試，含 2026-08-09 那台機器的
                                                   實際 settings.json 當回歸案例
openspec/changes/v1.26.105-one-hook-runs-one-is-dead/ — proposal / spec / tasks
```

修改檔：
```
install.sh / install.ps1                        — PreToolUse 那段改成呼叫共用 helper。
                                                   原本四份同樣的邏輯散在四支腳本裡，
                                                   只有 bash 那份跑得到 CI，爛掉的正好是
                                                   沒有測試碰得到的那半邊
scripts/update.sh / scripts/update.ps1          — 同上。這兩支裡最舊的那份順手一起換掉
                                                   （只有一個 matcher、全陣列比對，而且會
                                                   在 Windows 上寫入 bash 指令）
scripts/install-helpers/install-artifacts.cjs   — iron_rule_hook 改成先讀 settings.json 裡
                                                   **實際註冊的那條指令**，那個路徑才是
                                                   Claude Code 真的會跑的檔案。原本只問
                                                   「~/.claude/hooks 底下有沒有一份副本」，
                                                   所以那台機器一邊 6/6 全過、一邊每次
                                                   Bash 都 ERR_MODULE_NOT_FOUND。沒註冊
                                                   任何東西時才退回舊的候選清單。
                                                   另新增 iron_rule_hook_deps：光看路徑
                                                   存不存在還是抓不到那台機器 —— 兩份副本
                                                   位元組一樣，註冊的那個檔案**是在的**，
                                                   缺的是它第一行 import 的
                                                   `../shared/helpers.js`。ESM import 解不開
                                                   會在 payload 第一個位元組之前就殺掉 node，
                                                   所以「有這個檔案」跟「它跑得起來」是兩件事。
                                                   只在註冊的是 .js 時檢查，.sh 不 import 東西
install.sh                                      — PreToolUse 的 helper 呼叫從 `VAR=$(...)`
                                                   改成 `if var=$(...); then`。`set -eE` 底下
                                                   裸的命令替換會把 helper 的結束碼帶出來、
                                                   直接中止安裝，而且 2>&1 收進變數又沒印出來
                                                   —— 這個檔案開頭警告過的那個組合。兩支更新
                                                   腳本本來就有包，只有 install.sh 沒有
tests/edit-trigger-reminder.test.js             — 不再從 install.sh 切出 node -e 區塊 eval，
                                                   改成直接跑 helper。切區塊只驗得到 bash
                                                   那份，install.ps1 自己那份沒人看著爛掉
.gitignore                                      — 補上六個安裝腳本自己寫進檢出目錄的執行時
                                                   檔案（.node-path、.git-bash-path、cache/、
                                                   git-hooks/ 等）。這個檔案開頭的註解早就
                                                   寫過這個坑，但名單停在 .update-lock*，
                                                   所以實機每次升級都判定成 dirty tree、
                                                   每次都 git reset --hard。真正的代價是
                                                   那句警告變成每次都出現的雜訊 —— 使用者
                                                   真的手改過的東西會混在同一行裡捲過去
package.json                                    — 1.26.104 → 1.26.105
```

## v1.26.104 修改（檢查 commit 訊息的那道關卡，讀的是上一次的訊息）

新增檔：
```
hooks/ownmind-git-commit-msg.js                 — 用 git 傳進來的訊息路徑（$1）評估
                                                   commit_message* 類型的鐵律。挑規則看
                                                   條件類型、不看規則編號，因為每個人的
                                                   編號都不一樣。只讀快取不打 API：
                                                   pre-commit 幾秒前才在同一次 commit 裡
                                                   更新過。過濾掉 # 開頭的 git 註解行。
                                                   任何異常一律放行
tests/commit-msg-rules.test.js                  — 20 條。pre-commit 不再被舊訊息影響、
                                                   commit-msg 對真訊息判斷、
                                                   commit_message_contains 也要生效、
                                                   bypass、空快取放行、沒帶參數放行、
                                                   shell wrapper 真的有叫到 node、
                                                   沒安裝腳本時要放行、以及走真 git commit
                                                   的端到端：第一次擋、改好第二次要過
openspec/changes/v1.26.104-message-rules-judge-the-real-message/ — proposal / spec
```

修改檔：
```
hooks/ownmind-git-pre-commit.js                 — 拿掉 COMMIT_MSG_FILE 跟
                                                   getCommitMessage()。git 要到 pre-commit
                                                   跑完才寫 .git/COMMIT_EDITMSG，讀它拿到的
                                                   是上一次的訊息。訊息規則從 commitRules
                                                   整個濾掉，不是留著讓它通過 —— 條件判斷
                                                   沒訊息時回傳通過，留著會被算進「N 條全部
                                                   通過 ✓」。context 也不再放 commitMessage
                                                   這個鍵
hooks/ownmind-git-commit-msg                    — 寫死的 Co-Authored-By 比對保留（整行錨定
                                                   ＋不分大小寫，抓得到 git 自己的寫法
                                                   `Co-authored-by:`，而規則引擎是區分大小
                                                   寫的子字串比對、抓不到），後面再叫
                                                   ownmind-git-commit-msg.js 跑使用者自己的
                                                   規則。腳本不存在就跳過、不當成失敗，
                                                   半套安裝不該讓人不能 commit。補上
                                                   chain 既有掛勾的邏輯
install.sh / install.ps1                        — 兩邊的 git hook JS 清單都加
                                                   ownmind-git-commit-msg.js
scripts/update.sh / scripts/update.ps1          — 已安裝的三支 git hook wrapper 改成每次
                                                   更新都從檢出目錄重新複製，不再只修
                                                   CRLF。~/.ownmind 就是檢出目錄，pull 一
                                                   落地 hooks/ 立刻換新，但 git-hooks/ 是
                                                   安裝腳本複製的副本，而自動更新路徑不會
                                                   跑安裝腳本 —— 這一版剛好把工作從
                                                   pre-commit 搬到 commit-msg，不修的話
                                                   使用者會拿到新的那一半、舊的那一半留著
                                                   ，訊息規則整組靜靜失效。沒安裝過的不會
                                                   幫他裝。update.ps1 之前完全沒碰這個目錄
tests/updater-refreshes-git-hooks.test.js       — wrapper 清單從 install.sh 長出來（手寫
                                                   清單正是一開始漂掉的原因），驗證兩支更新
                                                   腳本都會刷新每一支、而且都不會無中生有
package.json                                    — 1.26.103 → 1.26.104
```

## v1.26.103 修改（搬檔案不算寫檔案）

新增檔：
```
openspec/changes/v1.26.103-rename-is-not-new-content/ — proposal / spec / tasks
```

修改檔：
```
hooks/ownmind-git-pre-commit.js                 — 新增 getRenameSources()：讀一次
                                                   `git diff --cached --raw -M -z`，把每個
                                                   目的地路徑對回它的來源路徑。
                                                   getStagedAddedLines() 多收 srcPath，改名的
                                                   檔案兩個路徑一起傳給 git——只給目的地那一個
                                                   時，git 沒有對得上的刪除side，配對不起來，
                                                   整份檔案都會被當成新加的。兩個 git 呼叫都
                                                   明寫 -M，不然使用者把 diff.renames 關掉就
                                                   整個退回原本的 bug。
                                                   掃描那一支加 --literal-pathspecs：git 給
                                                   回來的路徑，git 自己會當成 pathspec 讀，
                                                   `--` 擋不住。檔名叫 `:!victim.txt` 同時
                                                   是「排除」樣式，改名時會把目的地從自己的
                                                   差異裡排掉，同一次 commit 新加的密鑰完全
                                                   沒被掃到（實測掃描器回報通過）。raw 那一支
                                                   不加，因為它根本沒傳 pathspec，加了是沒有
                                                   作用的旗標配一段會誤導人的註解。
                                                   刻意沒加 blob SHA 豁免：配對修好之後沒有
                                                   任何測試分得出它在不在，而在會擋人的檢查裡
                                                   加一個沒測到的跳過分支，是多一個洞不是多
                                                   一層保險
tests/pre-commit-secret.test.js                 — +7 條（bug #10）：純搬移不擋、搬移同時新增
                                                   密鑰要擋、搬移同時改寫內容要擋、
                                                   diff.renames=false 也不擋、來源路徑是
                                                   pathspec 樣式時新增的密鑰仍要擋、同樣檔名
                                                   純搬移不擋、改名跟不相干的新增檔同時進
                                                   staging 時歸屬要正確。
                                                   第二三條是反面對照，少了它們「永遠不掃改名
                                                   檔」也會全綠。
                                                   pathspec 那條的種子檔刻意放 60 行：只放一行
                                                   的話相似度掉到 50% 以下，git 根本不報改名，
                                                   測試會在碰到要驗的程式之前就通過
package.json                                    — 1.26.102 → 1.26.103
```

## v1.26.102 修改（採集程式停掉，現在會有人被通知）

新增檔：
```
db/023_collector_silence_alert_state.sql        — 哪些機器已經通知過。鍵是 (user_id, machine)
                                                   不是 tool：一個排程死掉會同時凍住四個工具，
                                                   照 tool 記會把一台壞機器通知四次。broadcast_id
                                                   是為了修好之後把通知提早關掉
src/lib/broadcast-envelope.js                   — 從 install-check-alert-message.js 抽出來的
                                                   投遞信封（前 5 行、400 字、超出要留下「另有
                                                   N 項」）。第二個呼叫端出現才抽，不是預先抽
src/lib/collector-silence.js                    — 判斷哪台機器的採集程式現在是壞的。純函式、
                                                   時鐘用參數傳。訊號是「同一台機器內部對不
                                                   起來」，不是「幾天沒消息」，後者剛好會漏掉
                                                   真正發生過的那一種。刻意不判斷「哪些是新
                                                   的」——那題由 SQL 回答，因為兩個同時跑的
                                                   排程只有資料庫能仲裁
src/lib/collector-silence-message.js            — 兩個對象兩封信：給當事人的有修法、給管理員
                                                   的沒有（他在別人電腦上跑不了）
src/jobs/collector-silence-alerts.js            — 先記下、再 claim 並發送（同一個交易）、
                                                   最後才寫復原。第一次看到不通知，六小時後
                                                   還在才講；壞滿十四天再講一次。復原寫在最
                                                   後面，因為它們原本在最前面，一個寫失敗會
                                                   讓整輪在通知之前就中斷。每天 04:00 台北
                                                   時間跑一次
tests/collector-silence.test.js                 — 拿正式機真實快照當測資：一台會響、另外十台
                                                   必須安靜。後者才是值得釘住的那半
tests/collector-silence-message.test.js         — 兩封信各自的內容、投遞信封、時區、爆量截斷
tests/collector-silence-job.test.js             — 有狀態的假 DB，時鐘可以往前撥：驗證第一次
                                                   不發、六小時後才發、同一個人兩台機器修好
                                                   一台不能把另一台的通知一起收掉。假 DB 的
                                                   兩個時間常數改成從程式本體讀，不再自己抄
                                                   一份；常數本身用「要比最慢的排程久」這種
                                                   性質釘住。另有一組刻意讀 SQL 文字的測試，
                                                   並寫明「讀不等於跑」
tests/collector-silence-migration.test.js       — 建表冪等、鍵、外鍵刪除行為、欄位型別要跟
                                                   broadcast_messages.id 對得上、接線
openspec/changes/v1.26.102-collector-gone-quiet/ — proposal / spec / tasks
```

修改檔：
```
src/lib/install-check-alert-message.js          — 投遞信封那段搬到 broadcast-envelope.js，
                                                   對外的名字全部保留，既有 21 個測試不動照過
src/index.js                                    — 開機掃一次 + 註冊每日排程。這個條件是「時間
                                                   過了」才成立、不是「有東西上傳」才成立，所以
                                                   跟安裝檢測那支不同，它真的需要時鐘
openspec/BACKLOG.md                             — 第 4 項結案；刻意不做的那半（整台安靜的機器）
                                                   帶著量到的數字留下來
```

## v1.26.98 修改（回滾失敗時不要再回報「backup restored」）

新增檔：
```
tests/upgrade-rollback-honesty.test.js          — 收 review 補的五項各有測試：目錄被刪掉仍要
                                                   回報得出去（含對照組）、還原失敗只看自己的
                                                   錯誤、訊息摺一行且有上限、Windows 少建的
                                                   資料夾、git status 要留下原因
## v1.26.146 修改（一條讀起來只有一行的規範，issue #89）

新增檔：
```
src/utils/standard-fragments.js                 — 讀一條團隊規範時，把掛在底下的段落一起帶回來。
                                                   排序、字數上限、超過上限時講出下一步；以及
                                                   單獨讀到一個段落時附上它屬於哪一條
tests/standard-fragments.test.js                — 17 個測試。排序的樣本都刻意打亂過（照預期
                                                   順序排好的樣本，拿掉排序照樣綠），上限測試
                                                   會驗正式的那個數字而不只是注入的
openspec/changes/v1.26.146-a-standard-that-reads-as-one-line/ — proposal / spec / tasks
```

改動檔：
```
src/routes/memory.js                            — GET /:id 接上 attachStandardFragments；
                                                   batch-sync-standard 把段落在文件裡的位置
                                                   寫進 metadata.ord（新增、更新、只有位置變
                                                   都會寫），stats 多一個 reordered
mcp/index.js                                    — ownmind_get 的說明不再要讀的人分辨兩種存法，
                                                   改成「用 id 讀就會拿到全文，含 fragments」。
                                                   另外離線從本機快取讀到團隊規範時，明講
                                                   它的段落不在快取裡、不要當成完整的
tests/memory-visibility.test.js                 — 那個找防呆的斷言原本切固定位元組數，上面
                                                   多八行就把防呆擠出視窗。改成切到下一個
                                                   case（跟同檔 ownmindGetBlock 一樣的修法）
package.json / README ×3 / CHANGELOG.md         — 版號與紀錄
```

## v1.26.145 修改（守門的那個東西，被門外的人刪掉了）

新增檔：
```
openspec/changes/v1.26.145-the-reclaim-mutex-deletes-itself/ — proposal / spec / tasks
```

改動檔：
```
hooks/ownmind-session-start.sh                  — 收回過期鎖的那道門閂改成帶主人名字
                                                   （marker_is_ours）：刪舊鎖前確認一次、
                                                   離開刪門閂前再確認一次。原本「清掉沒人要
                                                   的門閂」會刪到還活著的那一個，門閂就是門，
                                                   於是一間給一個人的房間裡站了三個人
shared/update-lock.js                           — 同一套協定的 Node 版，同樣改；檔頭三步驟
                                                   改成四步驟，並補上「還沒解決的部分」。
                                                   另外：寫不進 token 的檔案現在會被刪掉再
                                                   回報失敗 —— 不刪的話，那個空檔案在每個
                                                   歸屬檢查眼裡都是「別人的」，連建它的人
                                                   都不會清掉它
tests/update-lock-mutual-exclusion.test.js      — 兩邊各三條回歸測試：門閂被拿走的人不准刪
                                                   別人的鎖、離開時不准刪別人的門閂、以及
                                                   「什麼都不收回」也會紅的反面對照。用插入
                                                   暫停打開時間窗，不靠運氣。搬函式的清單
                                                   改成從程式碼長出來（加一個小函式就讓所有
                                                   競爭者死在 command not found，看起來像
                                                   「沒有人拿到鎖」）。搬函式的比對改成錨在
                                                   行首（`update_lock` 會誤中
                                                   `acquire_update_lock`），相依偵測也認得
                                                   `fn;` 跟 `$(fn)`
```

## v1.26.144 修改（升級程式把自己寫出來的東西當成「你改的」）

新增檔：
```
tests/upgrade-dirty-tree-is-the-users.test.js    — chmod +x 的清單從兩支安裝腳本讀出來，逐一
                                                   檢查 repo 裡記錄成 100755；把腳本裡那行
                                                   git status 抽出來，在真的 git repo 上跑
                                                   三種狀態（只有未追蹤檔／改過追蹤檔／改過
                                                   權限），確認只有後兩種算「被改過」
openspec/changes/v1.26.144-upgrader-calls-its-own-output-your-changes/ — proposal / spec / tasks
```

改動檔：
```
hooks/ownmind-usage-scanner.js                  — 檔案權限記成 100755（內容沒動）。安裝腳本
                                                   跟同步腳本都會 chmod +x 它，記成 644 等於
                                                   每台機器裝完就永遠是「被改過」的狀態
scripts/interactive-upgrade.sh                  — 判斷「被改過」改用 --untracked-files=no；
                                                   未追蹤檔另外寫進紀錄，但不再觸發覆蓋
scripts/interactive-upgrade.ps1                 — 同上（IR-022 兩端一起改）
hooks/ownmind-session-start.sh                  — 拉新版前的 git stash 改成 pull --autostash。
                                                   原本 stash 完整段沒有任何地方 pop 回來，
                                                   一台機器上量到 30 筆沒放回去的暫存
.gitignore                                      — 加 bin/ reports/（standards/ 不加，
                                                   那是使用者自己的目錄）
```

## v1.26.142 修改（壞在沒人看得到的地方）

新增檔：
```
shared/auto-update.js                           — 完整升級流程唯一的一份實作（fetch → 比對 →
                                                   pull → npm → 同步腳本）。從 mcp/index.js 搬
                                                   出來，讓每兩小時跑一次的排程也能執行，
                                                   不再只有開 AI 工具才會升級。行程執行器、
                                                   時鐘、記錄器、橫幅佇列全部注入
tests/auto-update-shared.test.js                — 用注入的行程執行器實跑：跳過的三種情況、
                                                   沒有新版、完整升級順序、--autostash 退路、
                                                   Windows 用 npm.cmd + shell、每個步驟失敗
                                                   都要回報 step 並放掉鎖、失敗不蓋當日戳記
tests/collector-failure-reporting.test.js       — 掛掉／卡住／被跳過三種都要回報；訊息只進
                                                   稽核表且截到 1000 字；自我檢查不可以把
                                                   自己送出的失敗通知讀成成功
tests/selfcheck-roundtrip-weekly.test.js        — 每週一次的閘門；讀不到／日期壞掉／時鐘倒退
                                                   一律當成該跑
openspec/changes/v1.26.142-collectors-that-fail-in-private/ — proposal / spec / tasks
```

改動檔：
```
shared/scanners/reasons.js                      — 新增 adapter_error / adapter_timeout /
                                                   skipped_by_config，以及 isCollectorFailure
shared/scanners/base.js                         — 新增 reportCollectorState：沒走到掃描的工具
                                                   也要留下一筆紀錄
shared/scanners/selfcheck.js                    — 兩個新的失敗碼列入 LOCAL_BLOCKERS，否則自己
                                                   送出的失敗通知會被讀成「有新紀錄＝正常」
hooks/ownmind-usage-scanner.js                  — 每個工具加十分鐘上限（卡住不再拖垮後面的）；
                                                   掛掉／被跳過都回報；掃描完跑一次升級檢查
mcp/index.js                                    — 升級改為呼叫 shared/auto-update.js；不再自己
                                                   拿鎖、放鎖
src/routes/usage/events.js                      — 失敗心跳寫一筆 collector_error 稽核紀錄，
                                                   訊息截到 1000 字；其他原因一律不寫
scripts/install-helpers/self-check.cjs          — usage_roundtrip 在每日路徑上改為每七天跑一次
```

## v1.26.98 修改（那把「一次只准一個人更新」的鎖，其實鎖不住）

新增檔：
```
shared/update-lock.js                           — 更新鎖協定唯一的一份實作，MCP 與 Node 掛勾
                                                   共用。獨佔式建檔取得；接手死掉的鎖要先排隊、
                                                   拿到後再確認一次年齡才刪
tests/update-lock-mutual-exclusion.test.js      — 八個並行只能有一個拿到（shell 與 Node 各跑
                                                   一次）；含陽性對照證明測試抓得到競爭；接手
                                                   排隊與二次確認各有一個決定性測試
openspec/changes/v1.26.101-index-budget-to-projects/ — proposal / spec / tasks
openspec/changes/v1.26.100-memory-index-fits-reader/ — proposal / spec / tasks
openspec/changes/v1.26.98-update-lock-not-a-lock/ — proposal / spec / tasks
```

修改檔：
```
scripts/interactive-upgrade.sh / .ps1           — 還原失敗時誠實回報；記錄檔移出 ~/.ownmind
                                                   （Windows 端補上）；git status 失敗就停住
                                                   不再往下 pull；訊息摺一行、去控制字元、
                                                   兩邊同一個上限
scripts/install-helpers/report-error.sh / .ps1  — 可用 OWNMIND_REPORT_HELPER 指向 ~/.ownmind
                                                   外面的副本，讓「目錄已被刪掉」那種失敗還
                                                   回報得出去
hooks/ownmind-session-start.sh                  — 新增 lock_age_seconds / create_exclusive /
                                                   acquire_update_lock；原本是「檢查檔案不存在」
                                                   隔十行才 touch，兩個問題都不成鎖。改成先拿鎖
                                                   才記 update_check；搶輸記 update_skipped
                                                   （lock_held）而非 update_failed
hooks/ownmind-session-start.js                  — 原本檢查完鎖之後什麼都沒建立，改用共用實作真的
                                                   取得；沒東西可跑時立刻釋放
mcp/index.js                                    — 改用共用實作，移除自己那份 openSync wx 與
                                                   會誤刪的 stale 清除
tests/node-hook-parity.test.js                  — Windows 那份掛勾的鎖行為：搶輸要記 skip、
                                                   不能動別人的鎖、拿到鎖才宣告、沒東西可跑
                                                   時要把鎖還回去
tests/p3-update-event-semantics.test.js         — 兩條原本釘在舊寫法上的斷言改釘需求本身
tests/mcp-auto-update-cross-platform.test.js    — 同上，acquire 搬到共用檔後跟著改
.gitignore                                      — 忽略 .update-lock 系列。未追蹤檔案會讓
                                                   interactive-upgrade.sh 判定工作目錄髒掉、
                                                   直接 git reset --hard
scripts/interactive-upgrade.sh / .ps1           — 每個錯誤回報都附上失敗指令的日誌尾巴，
                                                   取代原本寫死的猜測；摺一行、去控制字元、
                                                   上限 300 字（兩邊同一個上限）
tests/upgrade-error-reason.test.js              — 呼叫點清單用掃的不用寫的；換行、上限、
                                                   取尾不取頭、沒日誌時要講清楚
shared/secret-detect.js                         — 長度啟發式改成量「有沒有單字結構」；刪掉
                                                   點分隔／斜線分隔兩個例外（量過之後多餘），
                                                   順便補上含斜線金鑰抓不到的漏洞
tests/secret-detect-word-shape.test.js          — 保證寫成比率（對整個倉庫掃過）不是清單；
                                                   13 種真金鑰逐一驗
shared/helpers.js                               — 新增 resolveProjectName()，專案名稱推導唯一
                                                   一份（只回資料夾名、不回路徑）
mcp/ownmind-log.js / mcp/index.js               — 每個活動事件都帶專案；MCP 自己那份推導刪掉
hooks/ownmind-session-start.sh / .js            — 同上，兩支掛勾送出的事件都帶
src/routes/memory.js                            — 事後重建工作記錄時挑出現最多次的專案
tests/activity-carries-project.test.js          — 三個送出端各驗一次；shell 那份手拼 JSON，
                                                   特別測資料夾名有引號時仍是合法 JSON
src/routes/usage/team-overview.js               — 遵守率改成也讀伺服器重建那種寫法
                                                   （details.compliance）；兩種都有時不重複計
tests/team-overview-api.test.js                 — 重建寫法、不重複計、violate 不計入、
                                                   壞資料不炸、真的沒資料仍顯示一槓
openspec/BACKLOG.md                             — 新增 37（context 欄位為什麼是空的，未證實）、
                                                   38（違規記錄沒地方顯示）、39（重建的場次
                                                   沒有專案名稱）
package.json / README ×3                        — 版號 1.26.98
```

## v1.26.97 修改（那道確認關卡從來沒有在擋）

新增檔：
```
db/022_bug_report_confirmation_source.sql       — 新增 confirmation_declared 欄位，附欄位註解
                                                   說明它是「客戶端宣告」而非「伺服器驗證過」，
                                                   既有資料回填 unknown
src/utils/confirmation-declared.js              — 正規化函式，route 與測試共用一份（同
                                                   activity-insert.js 的做法）
tests/bug-report-confirmation-declared.test.js  — 沒宣告絕不能變成 user_typed、unknown 不可
                                                   由客戶端直接宣告、工具說明不得再宣稱伺服器
                                                   會擋、migration 不得回填成 user_typed
```

修改檔：
```
src/routes/bug-reports.js                       — 寫入與列出這個欄位；檔頭原本寫「confirm_string
                                                   由伺服器把關」，改成說明它只驗值、驗不了人
mcp/index.js                                    — 工具說明拿掉「伺服器會擋自動填入」那句假保證，
                                                   新增必填的 confirmation_declared
tests/session-log-args.test.js                   — 原本斷言說明裡必須有「不可以自己填」那句
                                                   假保證，等於在保護它。改成斷言那句不能在、
                                                   且責任要放在 AI 身上
openspec/BACKLOG.md                             — 新增 36（AI 與使用者共用同一把金鑰）
```

## v1.26.96 修改（手寫的清單不會告訴你它漏了哪一個）

新增檔：
```
tests/shebang-eol.test.js                       — 從 git ls-files 長出「有 shebang 的檔案」清
                                                   單，斷言每一個都被 .gitattributes 的
                                                   eol=lf 涵蓋、且 index 裡不是 CRLF。清單太
                                                   短就當失敗（避免掃描壞掉時報平安）。另含
                                                   安裝腳本去 CR 的實跑驗證
```

修改檔：
```
.gitattributes                                  — 從白名單改成黑名單：一行 * text=auto eol=lf
                                                   加 Windows 原生格式例外。text=auto 不可省，
                                                   單寫 eol= 會關掉二進位嗅探並改壞檔案
.editorconfig                                   — 新增。.gitattributes 管 git，管不到編輯器
                                                   存檔，兩邊要一致
install.sh                                      — 複製 git 掛勾改用 install_git_hook()，用
                                                   tr -d 去掉 CR 並寫暫存檔再搬移。
                                                   .gitattributes 只管簽出，已經是 CRLF 的
                                                   機器 git 永遠不會自己修
scripts/update.sh                               — 沒有憑證時 interactive-upgrade 會退回這
                                                   支，而它從來不碰 git 掛勾。補上就地去 CR
client/src/pages/System/observed-users.js       — 組合鍵的分隔字元從原始 NUL 改成 \0 跳脫，
                                                   等價，但讓 git 不再把整個檔案當二進位
```

## v1.26.95 修改（掛勾寫的欄位到伺服器都被丟掉）

新增檔：
```
tests/hook-log-event-details.test.js            — 把兩支掛勾的 log_event 從檔案裡抽出來真的
                                                   執行，用 JSON.parse 讀回來。涵蓋沒有附加
                                                   欄位（逗號問題）、多組欄位、值裡含引號與
                                                   反斜線
```

修改檔：
```
hooks/ownmind-session-start.sh                  — log_event 的附加欄位改放進 details。伺服器
hooks/ownmind-iron-rule-check.sh                   收事件時只讀 details，平鋪的欄位一律丟掉，
                                                   所以升級失敗到底卡在哪一步從來沒傳出去過。
                                                   另外修：鍵沒配到值會讓迴圈永遠卡住；值裡的
                                                   控制字元會產生非法 JSON
hooks/ownmind-session-start.js                  — 同一個問題的第三份（Windows 沒 Git Bash 時
                                                   裝的就是它），logEvent 與 reportEvent 都改
tests/node-hook-reports-init.test.js            — 原本斷言平鋪的 e.status，等於在保護壞掉的
                                                   形狀。改成讀 details.status
```

## v1.26.94 修改（Windows MCP 路徑每次升級被寫壞）

新增檔：
```
tests/install-mcp-entry-path.test.js            — 把 install.sh 裡建 MCP_ENTRY 的 node 區塊
                                                   抽出來真的執行（不是手抄一份，手抄的只能
                                                   證明抄本會動），餵真實反斜線路徑驗證原樣
                                                   往返。另含舊寫法的重現，證明它確實把路徑
                                                   毀成 C:UsersVin.ownmindmcpstart.cmd；以及
                                                   一條形狀禁令：路徑不得再被引號包進 JS 原始碼
```

修改檔：
```
install.sh                                      — MCP_ENTRY 的路徑改用 process.argv[1] 傳入，
                                                   不再內插進 node -e 的原始碼。Windows 分支的
                                                   cygpath -w 是反斜線，內插後 \U \V \. \m \s
                                                   被 JS 剖析器當非法跳脫吃掉，後面那個要把
                                                   反斜線加倍的 replace 已無反斜線可加倍。
                                                   非 Windows 分支原本走 cygpath -m（正斜線）
                                                   沒事，一併改成同一種寫法
```

## v1.26.93 修改（換帳號從來沒真的換過）

新增檔：
```
tests/installer-key-update.test.js              — 兩支安裝腳本不再用字串 "ownmind" 當跳過
                                                   條件（含「不帶憑證的那幾個跳過要留著」的
                                                   反向斷言）；寫入邏輯在暫存 HOME 上真的
                                                   跑一次，驗金鑰換掉、未受管欄位保住；
                                                   conflicts 偵測（含環境變數不算衝突、
                                                   BOM 不再讓檔案消失）
```

修改檔：
```
shared/helpers.js                               — 新增 TOOL_TRIGGERS / detectToolTrigger；
                                                   TRIGGER_TAG_ALIASES 加 edit（含 write，
                                                   否則 Write 工具會觸發 edit 然後把作者標成
                                                   write 的規則全部丟掉）
hooks/ownmind-iron-rule-check.js                — 沒有指令時改用 tool_name 判斷觸發；edit 走
                                                   自己的路徑，不碰驗證引擎
hooks/ownmind-iron-rule-check.sh                — 同上。payload 現在吐兩個值：第一行 tool_name、
                                                   第二行起 command（指令可能含換行，工具名不會）
install.sh / install.ps1                        — PreToolUse 多註冊一個 matcher；判斷改成逐個
                                                   matcher 檢查（舊的問「這支掛勾裝過沒」，對所有
                                                   既有安裝都是「裝過」，新位置永遠裝不上去）。
                                                   install.ps1 另外把註冊指向 checkout 裡的 .js
                                                   掛勾 —— 複製到 ~/.claude/hooks 的那份根本啟動
                                                   不了（找不到 ../shared/）。這段沒有實跑過
.gitignore                                      — 忽略執行期寫進 checkout 的 state/
openspec/BACKLOG.md                             — 新增 32（觸發詞彙表該在存規則時就告訴作者）、
                                                   33（Windows 無 bash 那條路要在真機驗）、
                                                   34（兩支掛勾一個講中文一個講英文）
```

## v1.26.92 修改（改檔案時的鐵律，一條都沒出現過）

新增檔：
```
shared/edit-reminder-state.js                   — 一小時節流的狀態讀寫與判斷，依 session 分開
                                                   存。decide 是純函式、時鐘用參數傳，所以視窗
                                                   邊界不用等一小時也測得出來。壞檔／缺檔一律
                                                   當「沒有視窗」，代價是多列一次、不會少列。
                                                   抓取失敗時存的是五分鐘的短視窗，避免斷線期
                                                   間每次編輯都白等 3 秒
hooks/ownmind-edit-reminder.js                  — edit 觸發的完整實作。.js 掛勾 import 它、
                                                   .sh 掛勾用絕對路徑跑它（跟既有的
                                                   ownmind-verify-trigger.js 同一個做法），
                                                   所以視窗邏輯只有一份
tests/edit-trigger-reminder.test.js             — 兩支掛勾都用真實 Edit/Write payload 實跑；
                                                   節流那次要證明「沒有發出請求」；安裝器註冊
                                                   連跑兩次確認不重複也不漏
## v1.26.91 修改（提醒接通了，規則卻全被過濾掉）

新增檔：
```
tests/iron-rule-trigger-aliases.test.js         — 用實際出事的那組 tag 當樣本：標 回滾/
                                                   cleanup/升級 的規則現在對得上 delete 與
                                                   deploy，標 install/config 的仍然對不上
                                                   （放寬不能變成什麼都提醒）。另含舊過濾邏輯
                                                   的重現，以及 .sh 內嵌表與 shared/helpers.js
                                                   匯出值的逐項比對——把 .sh 裡的表抽出來真的
                                                   執行再比，不是比字串
tests/readme-version-sync.test.js               — 三份 README（en / zh-TW / ja）的版號要跟
                                                   package.json 一致，且標了本版版號的條目
                                                   三份都要有、或三份都沒有。連兩版只更新英文
                                                   版，沒有任何東西會紅
```

修改檔：
```
shared/helpers.js                               — 新增 TRIGGER_TAG_ALIASES 與
                                                   ruleMatchesTrigger()。同義字表是唯一真相，
                                                   .sh 那份是受測管制的複本
hooks/ownmind-iron-rule-check.js                — 內嵌的 tags.some(...) 換成 ruleMatchesTrigger
hooks/ownmind-iron-rule-check.sh                — 同一份表寫在 node -e 裡（不 import，避免再從
                                                   Git Bash 遞路徑給 node）。比對前轉小寫
docs/README.zh-TW.md                            — 補上本版版號與條目（原本停在 v1.26.90）
docs/README.ja.md                               — 同上
install.sh                                      — Claude Code 與 Cursor 兩個 MCP 區塊拿掉
                                                   「已設定就跳過」。那兩個區塊裡放的是 API
                                                   金鑰，跳過等於換帳號無效。改為一律寫入 +
                                                   合併保留未受管欄位 + 說明是寫入/更換/未變
install.ps1                                     — 同上（同一個 bug 的 PowerShell 版）。env
                                                   區塊改成合併，與 install.sh 行為對齊
scripts/install-helpers/resolve-credentials.cjs — 新增 conflicts（只比對檔案，不含環境變數）
                                                   ；補上缺漏的 stripBom
scripts/install-helpers/self-check.cjs          — 新增 credential_agreement 檢查項，兩個設定
                                                   檔金鑰不一致時 warn 並指名檔案
```

## v1.26.90 修改（鐵律提醒掛勾從來沒觸發過，全平台）

新增檔：
```
tests/iron-rule-hook-payload.test.js            — 真的把兩支掛勾跑起來、餵 Claude Code 實際
                                                   送的 payload，用「有沒有連到規則 API」當
                                                   訊號（空值檢查在讀金鑰之前）。另含一條
                                                   全 repo 掃描，禁止任何出貨腳本再用
                                                   readFileSync('/dev/stdin')——清單用
                                                   git ls-files 長出來，不手寫
```

修改檔：
```
hooks/ownmind-iron-rule-check.sh                — 四處 readFileSync('/dev/stdin') 改成
                                                   readFileSync(0)。Windows node 會把該 POSIX
                                                   路徑解析成 C:\dev\stdin 並拋 ENOENT，而拋出
                                                   點在 try 之外、外層又有 2>/dev/null，所以掛勾
                                                   每次都拿到空字串直接 exit 0。
                                                   另：取指令改讀 tool_input.command，
                                                   保留最上層 command 作為退路
hooks/ownmind-iron-rule-check.js                — 同樣的取值路徑問題（讀 stdin 本來就對）。
                                                   兩份一起改，避免重演「只修一份」。
                                                   取值路徑這一半跟平台無關，macOS 也一樣
                                                   拿不到，所以不是「Windows 沒提醒」，
                                                   是所有人都沒看過
```

## v1.26.89 修改（鐵律範本不再自動套用）

新增檔：
```
tests/no-silent-blocking-templates.test.js      — 用回報案例（記憶 829）的真實內文當測資：
                                                   證明比對器仍然會命中它（刻意留著，
                                                   當作「為什麼不能自動套用」的活證據）、
                                                   五個範本全部都會擋人（所以沒有
                                                   「只自動套用不擋人的」這條中間路）、
                                                   存檔路徑不再寫 verification、
                                                   回傳一定帶 applied:false
openspec/changes/v1.26.89-no-silent-blocking-templates/  — proposal / spec / tasks
```

修改檔：
```
src/routes/memory.js                            — 比中範本不再寫進 metadata.verification；
                                                   改回傳 template_suggestion（名稱、
                                                   applied:false、會不會擋人、一句可直接
                                                   轉述的話）。matched_template 保留給既有讀者
```

## v1.26.88 修改（Windows 升級中途靜默中止）

新增檔：
```
scripts/install-helpers/install-artifacts.cjs   — 「裝完了」的唯一定義。列出安裝該產出的東西
                                                   （SessionStart 掛勾、鐵律掛勾、hooks/lib、git-hooks、
                                                   技能檔、MCP 進入點），install.sh 收尾時斷言、
                                                   self-check.cjs 當成 install_complete 項目報上去。
                                                   查不到狀態一律算「缺」，不算「大概沒事」。
                                                   直接執行時是 CLI：完整 exit 0、缺件 exit 1 並列出缺什麼
tests/install-artifacts.test.js                 — 全在、單缺、多缺、把目錄放成檔案、路徑讀不到（EACCES）；
                                                   CLI 兩個結束碼；以及「清單只有一份」的來源守衛
tests/installer-node-paths.test.js              — 從腳本本身長出清單的四道守衛：node -e 裡不得有沒轉過的
                                                   路徑、_WIN 變數必須由 to_win_path 產生、node 錯誤不得丟給
                                                   /dev/null、升級日誌不得寫在回滾會刪掉的目錄。
                                                   解析不出來的 node -e 區塊算失敗，不算跳過
```

修改檔：
```
install.sh                                      — 接上 path-helpers.sh（缺檔時退回恆等函式）；
                                                   十處寫死在 node 程式碼裡的路徑改走 to_win_path；
                                                   node 錯誤改寫進 ~/.ownmind-logs/install-<時間>.log；
                                                   加 ERR trap 印出停在哪一行 + 日誌位置 + 最後幾行錯誤；
                                                   收尾前跑 install-artifacts 斷言，缺件就 [FAIL] + exit 1
                                                   （仍會先跑 self-check 把狀態送上伺服器）
scripts/update.sh                               — 同上接線；五處路徑改走 to_win_path（含四個
                                                   require('.../load-settings-safe.cjs')）；三處 node
                                                   錯誤改寫進 update-err.log；日誌目錄提前建立，
                                                   否則 `2>>` 失敗會讓 beacon 永遠送不出去
scripts/interactive-upgrade.sh                  — 升級日誌搬到 ~/.ownmind-logs/（回滾動不到的地方）；
                                                   send_upgrade_complete_beacon 的設定檔路徑改走 to_win_path
scripts/install-helpers/self-check.cjs          — 新增 install_complete 檢查項（呼叫 install-artifacts.cjs，
                                                   不自己再列一份清單）；checkNamesFor 同步
tests/upgrade-complete-beacon.test.js           — 抽出函式測試時一併 source path-helpers.sh，
                                                   否則測到的是一個實際上不存在的版本
```

審查後追加的修改：
```
hooks/ownmind-iron-rule-check.sh                — 接上 path-helpers.sh；讀金鑰／設定的三處
                                                   node -e 路徑改走 to_win_path。這一支在
                                                   Windows 上是實際被註冊的掛勾（install.sh 寫死
                                                   bash 版、沒有平台分支），所以金鑰一直讀回空字串
hooks/ownmind-session-start.sh                  — resolve-credentials.cjs、settings.json、
                                                   self-check.cjs 三個路徑改走 to_win_path
hooks/ownmind-worktree-setup.sh                 — 同上接線；settings.json、.mcp.json、
                                                   settings.local.json 三處
install.ps1                                     — 複製 hooks\lib\*.js（本來只有 update.ps1 有，
                                                   ps1 裝完沒更新過的機器，bash 掛勾在、
                                                   它要呼叫的 lib 不在）
install.sh                                      — set -e 改 set -eE（少了 E，函式裡的失敗不會觸發
                                                   ERR trap）；產出物檢查改回傳 2 而非 1；
                                                   傳 --home 給檢查器
scripts/interactive-upgrade.sh                  — 認得結束碼 2：回報但不回滾（回滾只還原
                                                   ~/.ownmind，~/.claude 早就改成新的了）；
                                                   日誌目錄退路改 mktemp -d，不再退回會被刪的目錄；
                                                   beacon 的 node 錯誤不再丟掉
scripts/install-helpers/install-artifacts.cjs   — locate 改回傳候選清單（任一存在即可），
                                                   讓 install.ps1 與 install.sh 兩種實作都算數；
                                                   hook_lib 加 applies（只有裝了 bash 掛勾才需要）；
                                                   目錄改檢查裡面的檔案；CLI 收 --home
scripts/install-helpers/path-helpers.sh         — 補上限制說明：結果是塞進單引號 JS 字串，
                                                   家目錄含單引號會壞（既有問題，$API_URL 同樣形狀）
tests/installer-node-paths.test.js              — 掃描範圍改成 git ls-files '*.sh'（手寫清單正是
                                                   hooks/ 漏掉的原因）；認得 --eval／--print；
                                                   拿掉「照變數名放行」，改成必須找得到經過
                                                   to_win_path 的賦值
```

**未動**：`install.ps1` 與 `install.sh` 在 Windows 上仍是兩條不同的路，升級只走 sh。兩者對齊記進 backlog 第 28 項。

## v1.26.87 修改（安裝檢測警告機制）

新增檔：
```
db/021_install_check_alert_state.sql          — 記錄哪些 (user_id, machine, check_name) 失敗已經公告過，
                                                 unique 唯一鍵防重複紀錄，含 first_seen_at／announced_at／
                                                 resolved_at／detail。唯一鍵同時是「認領」用的條件式
                                                 upsert 依據，兩支同時跑的評估只有一支搶得到
tests/install-check-alert-migration.test.js   — 讀 db/021 的 SQL 文字驗證：建表冪等、唯一鍵是
                                                 (user_id, machine, check_name)、user 刪除時連動刪除、
                                                 三個時間欄位都在
src/lib/install-check-alerts.js                — 決定哪些自我檢測失敗是「新的」、值得公告。
                                                 一次呼叫裡每台機器只用最新報告（processedMachines）；
                                                 其他舊報告一律跳過。明確文件化呼叫端責任：
                                                 報告須按時間遞減（新到舊）排列
tests/install-check-alerts.test.js             — 純函式測試：首次失敗、重複靜默、修復重臂、改文案不再問、
                                                 同機器混合狀態時只用最新報告、不同機器各算一次
src/lib/install-check-alert-message.js         — 把新失敗渲染成管理員能讀的通知。多台同因合併一行、
                                                 超限說明有幾項沒列出、單項超限也送但截斷標記。
                                                 尺寸標準是「使用者真的看得到的那一段」：兩支投遞端
                                                 （hooks/lib/render-session-context.js、mcp/index.js）
                                                 都只取前 5 行、接起來取前 400 字，所以一項就是一行、
                                                 最多 4 行內容 + 1 行遺漏數，欄位順序照「被砍掉時誰該
                                                 先活下來」排（檢查名／人機／版本在前，長敘述在後）
tests/install-check-alert-message.test.js     — 純函式測試：基本欄位、失敗合併、截斷計數、邊界情況、
                                                 演算法正確性（全部能裝、超限計數、單項切、empty版本）；
                                                 另有一組「使用者真的收到什麼」測試，在測試裡套用投遞端
                                                 那一行轉換後才斷言，驗證第二項、遺漏數那行、每項的版本
                                                 都活得下來
src/jobs/install-check-alerts.js              — 把 evaluateFailures 跟 renderAlertMessage 接成一支可執行的
                                                 job：讀最新報告（DISTINCT ON + jsonb_array_length 排除
                                                 beacon 列，用伺服器給的 l.id 排新舊、不用客戶端送來的
                                                 l.ts，免得一台時鐘設到明年的機器從此永遠不會再報）、
                                                 讀已知狀態、寫回 resolved／detail 變動、
                                                 新失敗先「認領」（條件式 upsert + RETURNING）再發廣播，
                                                 認領迴圈到寫廣播全在同一個資料庫交易裡（withTransaction
                                                 可注入，預設就是 db.js 那一支），認領順序照鍵值排過、
                                                 不跟著客戶端上傳的 checks 陣列走（鎖要撐到交易結束，
                                                 順序不固定就會死鎖），
                                                 中間任何一步失敗就整批回滾，連「認領已寫進資料庫、回應在
                                                 半路掉了」也蓋得到；別人已經 commit 的公告不受影響；
                                                 resolved／detail 兩種更新刻意留在交易外（跟認領無關，
                                                 而且沒有新失敗時根本不會開交易）；
                                                 只發給最舊的一位 super_admin（id 最小）、有效期 48 小時
tests/install-check-alerts-job.test.js        — 假 query 依 SQL 文字分派（同 tests/broadcast.test.js 手法）：
                                                 首次公告回傳 broadcast id、廣播鎖定唯一 super_admin、
                                                 狀態寫入用 ON CONFLICT 冪等、已公告過的失敗不再吵、
                                                 修好的檢查標記 resolved 但不發廣播、沒有 super_admin 時
                                                 狀態照寫但不硬發廣播、讀取 SQL 真的排除空 checks 報告、
                                                 排序用 l.id、有效期 48 小時；另有一份會記住狀態的假 DB，
                                                 附一個會在拋錯時把整張表還原的假交易，用來驗認領跟廣播
                                                 真的在同一個交易裡、廣播炸掉時整批回滾（表上不留任何
                                                 認領痕跡）、第二筆認領炸掉時第一筆也一起回滾且下一輪兩筆
                                                 都會發、回滾只動自己寫的（上一次已成功的公告不受影響）、
                                                 沒有 super_admin 時認領照樣 commit、認領順序不受客戶端
                                                 上傳順序影響，以及兩支同時起跑的評估只會產生一則廣播；
                                                 另有一筆讀原始碼的守門測試，確認沒注入時預設真的是
                                                 db.js 的 withTransaction（假交易看不到這件事）
tests/install-check-alerts-wiring.test.js     — 驗證接線本身：報告存好後真的觸發評估、評估失敗不影響
                                                 200 回應也不擋報告落地、400（缺 ts）不觸發評估；另讀
                                                 src/index.js 原始碼確認開機補跑一次且失敗被 catch 住
tests/source-files-are-text.test.js           — 回歸守門：遞迴掃 src/ 下所有 .js／.cjs，禁止出現會讓
                                                 grep 把檔案當二進位跳過的控制位元組（保留 tab／LF／CR）。
                                                 排除 src/public/dashboard/（gitignore 標記的前端編譯
                                                 產物，非手寫原始碼）
```

修改檔：
```
src/routes/debug.js                           — createDebugRouter 新增可選參數 onReportStored（預設是真正
                                                 的 runInstallCheckAlerts）；報告寫入成功、回應 200 之前
                                                 呼叫它，包在 try/catch，失敗只記日誌不影響回應。既有呼叫
                                                 端（src/app.js）不用改，因為參數是可選的。另外移除檔案
                                                 中兩個原始 NUL 位元組（曾讓整支檔案被 file/grep 判定成
                                                 二進位），一處改寫註解文字、一處把正則字面量換成 \x00
                                                 跳脫序列（行為不變）
src/index.js                                  — app.listen callback 內、seedDefaultPasswords() 之後補一次
                                                 runInstallCheckAlerts()，讓上版前已存在的舊報告也被評估；
                                                 失敗同樣只記日誌，不擋伺服器啟動
```

## v1.26.87 修改（金鑰只在環境變數裡：自動補寫成檔案）

新增檔：
```
scripts/install-helpers/ensure-key-file.cjs   — 金鑰只存在於環境變數時，自動補寫進
                                                 ~/.claude/settings.json 的 mcpServers.ownmind.env，
                                                 讓排程（launchd／工作排程器）跟 SessionStart 掛勾也讀得到。
                                                 resolve-credentials.cjs 從 v1.26.82 起就把這件事回報成
                                                 background_safe: false，但唯一的下場只是掃描器自己的
                                                 log 多一行、而那台機器的掃描器早就沒在回報了。
                                                 寫法比照 ensure-session-hook.cjs：先寫 .tmp 再 rename、
                                                 讀不懂或不是設定物件就拒改並回報原因、
                                                 ~/.ownmind/.no-key-file 是使用者的退出開關。
                                                 五種結果：repaired／already_safe／opted_out／
                                                 no_credentials／error，一行機器可讀 + 一句人話，
                                                 而且那句話只講位置、不會印出金鑰本身
tests/ensure-key-file.test.js                 — 把修復程式當獨立程序真的跑（子程序的環境是重新造的，
                                                 免得開發機自己的 OWNMIND_API_KEY 讓「完全沒有金鑰」
                                                 那個案例偷偷變成別的案例）：環境變數限定、已在檔案裡、
                                                 URL 已由別的檔案設定就不再複製一份、壞掉的 JSON、
                                                 合法 JSON 但不是物件、退出開關、完全沒有金鑰、BOM、
                                                 重複執行不改檔。「先 .tmp 再 rename」用佔住 .tmp 路徑
                                                 的方式驗（沒有殘骸這件事直接寫檔也成立、分不出來）。
                                                 另含自我檢測五種結果對應 pass／warn／fail 的斷言，
                                                 以及四支安裝腳本真的有呼叫；四支各刪一次呼叫、
                                                 helper 五處各壞一次、自我檢測三處各壞一次，全部驗過會紅
```

修改檔：
```
scripts/install-helpers/self-check.cjs        — 新增 background_credentials 檢查項：先跑修復、再回報
                                                 結果。已經在檔案裡或這次補寫成功都是 pass（detail 會說
                                                 是哪一種）、使用者自己退出是 warn（v1.26.87 的警告機制
                                                 只廣播 fail、故意不吵 warn）、修復失敗是 fail 並帶原因
                                                 跟可執行的 fix；完全沒有金鑰也是 warn，因為
                                                 api_key_format 已經在報同一件事了。
                                                 檔頭那個會過期的「9 項檢查」數字改成指向清單本身
install.sh / install.ps1 / scripts/update.sh / scripts/update.ps1
                                              — 四支都照 ensure-session-hook.cjs 既有寫法呼叫
                                                 ensure-key-file.cjs 並印出那一行摘要，標籤跟著結束碼走
                                                 （失敗不會印成 [ OK ]）。install.ps1 那段一樣放在自己
                                                 最後一次寫 settings.json 之後，否則修復會被舊快照蓋回去
```

## v1.26.87 修改（讀鐵律的三個地方，只有一個跟得上 API 換格式）

新增檔：
```
hooks/lib/iron-rule-sync.js                   — 兩個純函式：把 API 回傳解成鐵律陣列、決定要不要
                                                 覆蓋快取。API 回的是 { data: [...] }，pre-commit 掛勾
                                                 卻用「是陣列才算數」去讀，所以每次同步都拿到零條，
                                                 還把這個零條寫回快取蓋掉好資料；呼叫端看到零條就
                                                 直接放行、一個字都不印。快取只要過期一次，下一次
                                                 commit 就是 27 條規則全部不檢查而畫面全靜音。
                                                 shouldOverwriteCache 因此規定：抓不到資料絕不覆蓋，
                                                 舊快取至少還擋得住東西、空快取什麼都擋不住
tests/iron-rule-sync.test.js                  — 用正式機真實回傳格式當素材驗解析；驗空結果不覆蓋；
                                                 另外三條原始碼守衛，防止有人把那段 Array.isArray
                                                 寫回去、或把共用解析器晾在旁邊不用
tests/iron-rule-check-response-shape.test.js  — 把 .sh 裡那段解析抽出來當獨立程序真的跑，餵包裝過
                                                 跟沒包裝的兩種格式；並重現舊寫法會丟 TypeError
```

修改檔：
```
hooks/ownmind-git-pre-commit.js               — 改用共用解析器；快取寫入加上「抓不到就不覆蓋」的守衛
hooks/ownmind-iron-rule-check.sh              — 同一個格式問題的第三個受害者，而且是實際安裝在使用者
                                                 settings.json 裡的那一支。它對包裝過的回應直接丟
                                                 TypeError、整段 node -e 死掉，輸出又被 $( ) 吃掉，
                                                 所以 PreToolUse 的鐵律提醒從 API 換格式之後就沒再出現過。
                                                 .js 版本在 v1.19.20 修過同一個問題，這份被漏掉
```

## v1.26.65 ～ v1.26.86 修改（收集器可靠性連續二十二版；每一版的來龍去脈見 CHANGELOG）

這十版是同一條線：**「後台說沒資料」到底是真的沒工作，還是收集器壞了沒人知道。**
每一版的完整說明在 CHANGELOG.md，這裡只列動到哪些檔。

新增檔：
```
db/018_collector_heartbeat_reason.sql       — v1.26.69 收集器為什麼沒東西（封閉原因碼）
db/019_collector_heartbeat_per_machine.sql  — v1.26.73 心跳鍵值改 (user_id, tool, machine)
db/020_activity_source_width.sql            — v1.26.78 activity_logs.source 從 10 字放寬到 64 字
                                              （system_auto 11 字、system_server_auto 18 字，
                                              從建表以來一次都沒進去過，而且會害整批被退回）
src/routes/activity.js                      — v1.26.78 每一筆活動紀錄各自處理，一筆被拒不再退整批；
                                              回應多一個 failed 計數、日誌記下是哪種事件
shared/scanners/reasons.js                  — v1.26.69 六個原因碼的唯一定義，client / server 共用
shared/scanners/gemini-conversations.js     — v1.26.68 Antigravity 三個介面的對話檔日期來源
shared/scanners/sqlite-cli.js               — v1.26.71 所有 sqlite3 CLI 查詢的唯一入口（-readonly
                                              開不起來就退回複本，複本要連 -wal / -shm 一起帶）
shared/scanners/selfcheck.js                — v1.26.72 本機掃到的 vs 伺服器手上有的，比對成五種結論；
                                              v1.26.77 改用 Authorization: Bearer（伺服器只認這個，
                                              原本送 X-API-Key，從 v1.26.72 起每一次都 401）
hooks/ownmind-selfcheck.js                  — v1.26.72 升級後自測的獨立入口
src/routes/usage/self-check.js              — v1.26.72 GET /api/usage/self-check（只回自己的列）
client/src/pages/System/machine-groups.js   — v1.26.73 純函式：groupClientsByMachine + osLabel。
                                              狀態取最糟的工具、心跳取最新、壞的排前面
scripts/install-helpers/ensure-scanner-schedule.sh  — v1.26.79 排程死了就接回去（macOS launchd /
                                              Linux systemd）。活著就完全不碰；修完回頭問系統，
                                              不信註冊指令自己的 exit code；修不好往伺服器回報
hooks/ownmind-session-start.js              — v1.26.83 補齊 bash 版的八件事（廣播、記憶檔同步、
                                              共用排版模組、conditional sync、三種補送、每日更新
                                              檢查），並補上「回報給伺服器」那一行——少了它，
                                              一台正常的 Windows 在伺服器上跟壞掉的一模一樣
tests/node-hook-parity.test.js              — 新增。起假伺服器、實際執行掛勾，斷言送出的請求
                                              與寫出的檔案
tests/node-hook-reports-init.test.js        — 新增。釘住「載入成功要讓伺服器看得到」
scripts/install-helpers/resolve-credentials.cjs — v1.26.82 金鑰跟網址到底放在哪，一份答案。
                                              依序找 settings.json、settings.local.json、
                                              ~/.claude.json、環境變數。多回一個
                                              background_safe：金鑰只在環境變數時，排程叫起來的
                                              掃描器讀不到，那是 Adam 掃描器死掉的真正原因
shared/helpers.js                           — v1.26.82 readCredentials 改問上面那支（不帶參數時）。
                                              帶 settingsPath 維持只讀單一檔案的舊行為
hooks/ownmind-session-start.js              — v1.26.83 載入成功/失敗補上傳伺服器（bash 版一直有、
                                              Node 版漏了；沒有這筆，Windows 掛勾好壞在伺服器端
                                              分不出來，memory_load 檢測會永遠誤判）
tests/node-hook-reports-init.test.js        — 新增。起假伺服器跑真掛勾，斷言事件真的送達
hooks/ownmind-session-start.sh              — v1.26.82 內嵌的找金鑰改問共用解析器
hooks/ownmind-usage-scanner.js              — v1.26.82 找不到金鑰的錯誤訊息列出全部三個位置
                                              （原本只寫 settings.json，把人指去最不可能的地方）；
                                              金鑰只在環境變數時明白警告
tests/resolve-credentials.test.js           — 新增。含一個直接重現 Adam 狀況的案例
hooks/lib/conditional-sync.js               — v1.26.82 記憶快取蓋帳號指紋（伺服器+金鑰雜湊，
                                              不存金鑰）。對不上整份拒收重新下載；沒指紋的
                                              舊快取一律當別人的。掃描器 v1.26.69 修過同一個
                                              危險，這是漏掉的另一半
tests/cache-account-fingerprint.test.js     — 新增。含「別人的快取被拒收」「金鑰不落地」
scripts/install-helpers/self-check.cjs      — v1.26.82 改用共用解析器；加 --quick 模式（自動更新每天跑，跳過唯一會掃描
                                              所有本機資料庫的那一項）；加第十項 memory_load：
                                              記憶到底有沒有真的載入。
                                              結論問伺服器（本機對自己的健康報告最不能信），
                                              本機負責附證據：設定裡那行指令原文、指令指向的
                                              檔案在不在、bash 跟 node 各解析到哪（bash 在
                                              System32 就是 WSL，特別標出來）
src/routes/usage/self-check.js              — 多回 memory_load：最近一次自動載入時間、七天內
                                              次數。hook 自動載入跟 AI 自己呼叫分開算，後者
                                              不算功能會動
tests/self-check-memory-load.test.js        — 新增。伺服器端測 SQL 形狀與空值語意，用戶端測
                                              三種降級路徑，最後一項跑真的 settings.json
scripts/install-helpers/session-hook-command.cjs    — v1.26.86 未加引號、路徑含空格的舊設定
                                              也認得出是我們的（Jane Doe 型家目錄漏修問題）；
                                              v1.26.85 Windows 掛勾改指 ~/.ownmind/hooks
                                              （.claude/hooks 那份的相對 import 解不開、
                                              Node 直接 ERR_MODULE_NOT_FOUND，一行都沒跑）；
                                              v1.26.80 SessionStart 掛勾的指令怎麼下，
                                              四支安裝／更新腳本共用這一份。Windows 走 node
                                              絕對路徑（bash 在那邊會被 WSL 接走）；判斷要不要
                                              重寫時連指令內容一起看，只看 matcher 齊不齊的話
                                              六台壞掉的機器一台都修不到；使用者自己改過的
                                              指令不覆蓋
scripts/install-helpers/ensure-scanner-schedule.ps1 — v1.26.79 同上的 Windows 版。被停用的工作也算
                                              壞掉（查得到、永遠不會跑）。註冊邏輯只有一份，
                                              轉呼叫 register-scanner-task.ps1，這裡不複製。
                                              v1.26.130 健康判斷改呼叫 schedule-health.ps1
scripts/install-helpers/schedule-health.ps1 — v1.26.130 Test-ScheduleHealthy /
                                              Test-TaskBelongsToInstall。修復端問的問題要跟
                                              自我檢測端一樣：工作屬於別的安裝目錄也算壞掉。
                                              純字串邏輯、不碰 Task Scheduler，所以不在
                                              Windows 也執行得到
tests/scanner-task-durability.test.js       — v1.26.65
tests/scanner-blind-scan.test.js            — v1.26.65
tests/scanner-vscode-multipath.test.js      — v1.26.66
tests/mcp-client-tool-attribution.test.js   — v1.26.67
tests/scanner-antigravity-conversations.test.js — v1.26.68
tests/collector-silence-reason.test.js      — v1.26.69
tests/sqlite-readonly-fallback.test.js      — v1.26.70
tests/scanner-opencode-closed.test.js       — v1.26.71
tests/install-scanner-module-list.test.js   — v1.26.71
tests/selfcheck-report.test.js              — v1.26.72
tests/selfcheck-endpoint.test.js            — v1.26.72
tests/selfcheck-entry.test.js               — v1.26.72
tests/self-check-usage-roundtrip.test.js    — v1.26.72
tests/heartbeat-per-machine.test.js         — v1.26.73
tests/machine-groups.test.js                — v1.26.73
tests/team-overview-last-active.test.js     — v1.26.74
tests/activity-source-width.test.js         — v1.26.78
tests/scanner-schedule-repair.test.js       — v1.26.79 Unix 那支是真的執行（暫時 HOME + 假的
                                              launchctl / systemctl），Windows 那支只能讀文字
tests/session-hook-command.test.js          — v1.26.80 把 update.sh 裡那段 node 程式碼抽出來
                                              真的跑，platform 假造成 win32；v1.26.86 改配合
                                              ensure-session-hook.cjs 的新呼叫方式
scripts/install-helpers/ensure-session-hook.cjs — v1.26.86 SessionStart 設定修復的唯一實作。
                                              原本 install.ps1 用 PowerShell 字串傳遞鏈做這件事，
                                              從 v1.26.82 起一次都沒真的執行過（采瑤升到 84 之後
                                              設定仍是舊的單一 null matcher，就是鐵證）。
                                              自己讀寫設定檔、原子寫入、讀不懂或不是設定物件
                                              就拒改並回報錯誤；.no-session-hook 開關由它遵守
tests/ensure-session-hook.test.js           — v1.26.86 把修復程式當獨立程序真的跑，餵采瑤跟 Adam
                                              兩台機器逐字真實的壞設定；「安裝腳本忘記呼叫它」
                                              用破壞法驗過會紅
tests/post-commit-version-reminder.test.js  — v1.26.86 在臨時 git repo 實跑 post-commit 掛勾：
                                              沒有 package.json 的專案必須安靜（bug #13）
openspec/changes/v1.26.{65,66,67,68,69,70,71,72,73,74,76,77,78,79,80}-*/{proposal,spec,tasks}.md
```

修改檔：
```
hooks/ownmind-usage-scanner.js              — v1.26.65 讀不到目錄不得回報成沒有檔案；v1.26.66 多候選
                                              路徑；v1.26.69 送出原因碼；v1.26.72 回傳掃描結果供自測用
shared/scanners/base.js                     — v1.26.65 readSince 回報 scanned / skipped；v1.26.69 原因碼
shared/scanners/{claude-code,codex}.js      — v1.26.65 同上
shared/scanners/antigravity.js              — v1.26.66 資料夾改名；v1.26.68 三個介面；v1.26.69 原因碼
shared/scanners/vscode-telemetry.js         — v1.26.66 多候選；v1.26.70 關著也要讀得到；v1.26.71 改用
                                              共用的 sqlite-cli.js
shared/scanners/opencode.js                 — v1.26.71 自己的資料庫也是 WAL，同一條退路
shared/helpers.js                           — v1.26.67 「跑在哪個工具裡」收成一份規則
mcp/index.js, mcp/ownmind-log.js            — v1.26.67 四個呼叫點改用共用規則
src/routes/usage/events.js                  — v1.26.69 收原因碼；v1.26.73 三欄鍵值 + 每人每工具 20 台上限；
                                              v1.26.76 心跳那句 SELECT 的每個參數都要標型別（不標的話
                                              同一個參數會被認出兩種型別，Postgres 整句拒收）
src/routes/usage/admin-clients.js           — v1.26.69 回原因；v1.26.73 回 os
src/routes/usage/index.js                   — v1.26.72 掛上 /self-check
src/routes/usage/team-overview.js           — v1.26.74 最近活動改讀三個來源取最新；v1.26.75 額外兩個
                                              來源改用 SELECT 裡的純量子查詢、一個人算一次（寫成
                                              LATERAL 會跟著工作紀錄筆數跑），排序改指名輸出欄名
src/routes/activity.js                      — v1.26.74 統計儀表板同一組來源；v1.26.75 補上「這一欄
                                              刻意不套時間區間」的理由：那頁列所有人，套了會讓
                                              「這期間沒動靜的人」變空白，而那正是要找的人
src/routes/me.js, src/routes/me-narrative.js — v1.26.73 一人多台時版本取最新那台（DISTINCT ON）
scripts/install-helpers/self-check.cjs      — v1.26.72 安裝後自我檢查加第九項：回頭跟伺服器對帳
scripts/windows/{register-scanner-task.ps1,run-hidden.vbs}, scripts/interactive-upgrade.ps1
                                            — v1.26.65 排程不可先刪再建、VBS 要回傳真的 exit code
scripts/update.sh, scripts/update.ps1       — v1.26.79 自動更新每次檢查排程還活著（原本只有手動
                                              升級才會，而沒有人手動升級，所以修復從來沒生效過）。
                                              修不好不會讓整個更新算失敗，但一定回報伺服器；
                                              v1.26.80 掛勾指令改問 session-hook-command.cjs
                                              （原本寫死 bash，每天把 Windows 的 node 版蓋掉），
                                              update.ps1 另外開始同步 node 版掛勾檔；
                                              v1.26.86 設定修復改成呼叫 ensure-session-hook.cjs，
                                              結果一行印在升級畫面上，失敗看得見
install.ps1                                 — v1.26.80 不再用 Get-Command bash 判斷（那會抓到
                                              WSL 的 bash），改問共用 helper；SessionStart 補齊
                                              四個 matcher；v1.26.86 刪掉那段從未真的執行過的
                                              PowerShell 修復塊，改呼叫 ensure-session-hook.cjs，
                                              且呼叫點在最後一次寫 settings.json 之後（審查抓到
                                              原本會用舊快照把修好的檔案蓋回去）
hooks/ownmind-git-post-commit.js            — v1.26.86 版號提醒改讀「正在 commit 的專案」的
                                              package.json，沒有就整段閉嘴（原本讀 OwnMind 自己的
                                              版本去管別人的 repo，Go 專案每次 commit 都被
                                              叫去打錯的 tag，bug #13）
install.sh                                  — v1.26.71 scanner 模組清單改成用掃的；v1.26.79 註冊完
                                              回頭問 launchd / systemd 一次，不再只信註冊指令沒報錯
                                              （Windows 從 v1.17.12 就這樣做，Unix 這邊一直沒有）；
                                              v1.26.86 設定修復同樣改呼叫 ensure-session-hook.cjs
client/src/pages/System/SystemConfigPage.jsx — v1.26.73 依電腦分組（舊的 key={c.tool} 會撞號）
client/src/pages/System/observed-users.js   — v1.26.69 靜默附原因；v1.26.73 附機器名
client/src/i18n/{zh,en,ja}.json             — v1.26.73 系統設定頁的機器分組字串，三語系同步
```

## v1.26.64 修改（搜尋不再把找到的東西全部倒出來，Bug #11）

新增檔：
```
shared/memory-search-result.js        — 搜尋結果的塑形：允許清單式的欄位挑選、內容截成
                                        400 字預覽、附上原長度與截斷旗標、回報總數與實回數。
                                        放 shared/ 是因為離線快取搜尋同一個毛病，比照 tokenize
tests/memory-search-result.test.js    — 12 項，含「未知的新欄位也不可以漏出去」
tests/session-query-bounds.test.js    — 8 項，LIMIT 要在 ORDER BY 之後，且欄位要具名
openspec/changes/v1.26.64-bounded-search-results/{proposal,spec,tasks}.md
```

修改檔：
```
src/routes/memory.js                  — GET /search 改具名欄位 + LIMIT + 另跑一次 COUNT，
                                        回 { data, total, returned }
src/lib/session-query.js              — 具名欄位 + LIMIT。上限改成參數並夾在 50 以內，因為這支
                                        builder 有兩個呼叫者：搜尋要少少幾筆、ownmind_get 的
                                        工作紀錄列表要看得到一個月（審查抓到的）
src/routes/session.js                 — /recent 接受 ?limit=，由 builder 夾上限
mcp/offline.js                        — 新增 findCachedMemory，讓斷網時也讀得回完整的那一則
mcp/index.js                          — ownmind_get 加 id（type 改非必填、handler 自己擋兩者皆空）；
                                        ownmind_search 說明改寫成「這是預覽」；回應加 memory_total /
                                        memory_returned
mcp/offline.js                        — localSearch 改走共用塑形，離線線上同形狀
client/src/pages/Portal/MemorySearchModal.jsx — 認得新的物件形狀（保留陣列分支，對舊伺服器也能用）
tests/offline.test.js                 — 7 項改成透過 .data 取列（比對邏輯沒變、只是取法變了）
tests/memory-visibility.test.js       — schema 窗口從 600 放寬到 1400（描述變長，切不到不是行為問題）；
                                        新增一項盯「type 不再必填之後 handler 有自己擋」
CHANGELOG.md, FILELIST.md, README.md, docs/README.{zh-TW,ja}.md, package.json — v1.26.64
openspec/BACKLOG.md                   — 新增第 13 條（footer 版本更新紀錄永遠是空的）
```

這一版學到的：

- **修好一個 bug 會讓下一個 bug 顯形。** v1.26.37 把「搜不到」修成「搜得到」，於是「回太多」才變成問題。這不是退步，是原本被蓋住的第二個缺陷。發布修補之後要回頭看它解鎖了什麼。
- **截斷一定要配一條讀全文的路。** 只做截斷是把「太多」換成「不夠」。這次是 `ownmind_get` 加 `id`，如果沒發現它只吃類型不吃編號，這個修補會變成另一個 bug。
- **欄位要用允許清單，不要用排除清單。** `previous_content` 之所以會被送到每一個搜尋結果裡，就是因為 `SELECT *`。排除清單漏掉一個是安靜的，允許清單漏掉一個會馬上被測試抓到。
- **既有測試變紅要先分辨是行為變了還是窗口切不到。** 這次 11 支紅的裡面，2 支只是描述變長導致 `slice(idx, idx+600)` 切不到，跟行為無關；真的行為變的那一支，我補了替代的保護（type 不再必填，就要有測試盯 handler 自己擋）。
- **對抗審查抓到的兩條，都是「我沒去讀的那個呼叫者」。** 加 LIMIT 時只看了搜尋那條路，沒發現同一支 builder 還被工作紀錄列表用著；加 `ownmind_get(id)` 時沒去看旁邊每一個分支都有離線退路。**缺陷不在我寫的程式碼裡，在我沒讀的那段。** 動到共用函式，要先數清楚有幾個呼叫者。
- **打包給審查者的東西自己要檢查。** 這次 `sed` 範圍抓錯，最關鍵的那段 SQL 根本沒進去，審查者只能回報「看不到、無法驗證」。等於白跑一輪。

## v1.26.63 修改（臨時密碼不再一用就變成永久鑰匙）

新增檔：
```
src/utils/first-password.js       — 兩個安全決策的純函式：登入該回什麼、新端點該拒絕什麼。
                                    照 setup-recovery.js 的既有做法，因為 me.js 是 1119 行
                                    的模組級 router、沒有依賴注入，為了測一支端點重構它風險太大
tests/first-password.test.js      — 15 項，含「四種拒絕必須產生完全相同的答案」跟限流器結構檢查
tests/login-outcome.test.js       — 9 項，新的第四種結果 + 既有三種原封不動
openspec/changes/v1.26.63-first-password-before-key/{proposal,spec,tasks}.md
```

修改檔：
```
src/routes/me.js                     — 登入改問 first-password 政策；新增 POST /first-password；
                                       開機算一個 DUMMY_HASH（不寫死在原始碼，那個形狀會被密鑰掃描誤判）；
                                       登入的稽核紀錄加 issued_key 欄位
src/app.js                           — authLimiter 掛上 /api/me/first-password
client/src/pages/login-outcome.js    — 第四種結果 first_password，排在 api_key 檢查之前
client/src/pages/LoginPage.jsx       — 第三種模式，沿用既有 mode 狀態的形狀
client/src/i18n/{zh,en,ja}.json      — 5 個新 key
CHANGELOG.md, FILELIST.md, README.md, docs/README.{zh-TW,ja}.md, package.json — v1.26.63
openspec/BACKLOG.md                  — 第 1 條出去，換成「管理員重設那條路 + 要不要輪換 api_key」
```

沒改的檔（刻意）：
```
src/middleware/                      — 沒有加任何擋 must_change_password 的中介層。那個旗標是開機
                                       種子程式給「所有沒密碼的帳號」設的，也就是所有沒登入過後台
                                       的人，而他們天天在用 MCP。中介層一擋，他們全停
client/src/components/common/RequireFreshPassword.jsx — 留著。登入那條路它已經不再是唯一防線，
                                       但管理員重設密碼那條路還需要它做提醒
src/routes/me.js POST /change-password — 已登入的人改自己選的密碼，跟這件事無關
```

這一版學到的：

- **「旗標是 TRUE 的人有多少」決定了修法。** backlog 條目暗示在中介層擋，聽起來合理，查完才發現那會讓整隊人的 MCP 停掉。修安全問題前要先量受影響的族群，不能只讀條目描述。
- **繞道要用清空的，不要用堵的。** localStorage 那個鍵之所以能被繞過，是因為伺服器早就把鑰匙給出去了。把發鑰匙的時機往後挪，那個鍵就自然失去價值，不需要再多一道檢查。
- **拒絕訊息的一致性要用測試釘死。** 四種拒絕理由完全不同，但外面看到的必須是同一個答案，這件事光靠讀程式碼看不出來，要斷言 `Set(bodies).size === 1`。
- **零發現的審查要自己抽驗。** 這次對抗審查回零，我自己另外查了稽核欄位有沒有列舉限制、簽章對不對，那是審查者不可能知道的事。
- **提示詞寫成「攻擊它」會被拒答。** agy 第一次直接不做，換成「上線前的防禦性審查」才跑。

## v1.26.62 修改（發廣播不用再去別的分頁抄 user_id）

新增檔：
```
client/src/pages/System/broadcast-recipient-filter.js — 收件人選單的過濾規則。純函式，不含 React 也不打網路
client/src/pages/System/broadcast-ends-at.js          — datetime-local 的無時區字串 ↔ ISO 8601 兩向轉換
client/src/pages/System/broadcast-payload-build.js    — 把表單狀態組成請求內容。從送出函式裡抽出來，
                                                        因為兩個欄位現在都是「算出來的」而不是「打出來的」
tests/broadcast-recipient-filter.test.js              — 8 項，含「名單還沒回來就先 render」那次呼叫
tests/broadcast-ends-at.test.js                       — 8 項，斷言全部寫成不綁時區
tests/broadcast-payload-build.test.js                 — 10 項，含 cooldown 填 0 的迴歸測試
openspec/changes/v1.26.62-broadcast-recipient-picker/{proposal,spec,tasks}.md
```

修改檔：
```
client/src/pages/System/NewBroadcastModal.jsx — 收件人改人名多選、結束時間改日期選擇器並預設 30 天後；
                                                對抗審查後補上下鍵與 ARIA、選單關閉改看 relatedTarget、
                                                重複挑同一人擋掉、cooldown 0 不再被吃掉
client/src/i18n/{zh,en,ja}.json               — 兩個 key 換說法、五個新 key、刪掉 ends_at_placeholder
package-lock.json                             — ip-address 10.2.0→10.4.0（3 個通報）、playwright 1.53→1.62
mcp/package-lock.json                         — hono 4.12.32→4.13.0、fast-uri 3.1.4→3.1.5
CHANGELOG.md, FILELIST.md, README.md, docs/README.{zh-TW,ja}.md, package.json — v1.26.62
```

相依套件漏洞（只動 lockfile、沒改任何版本範圍宣告）：

| 套件 | 位置 | 正式路徑上？ |
|---|---|---|
| `ip-address` | `express-rate-limit` → IP 限流的鍵 | **是**。前導零 IP 解讀不一致，有機會繞過限流 |
| `playwright` | root devDependency | 否 |
| `fast-uri` | mcp `ajv` → JSON schema `$ref` | 否 |
| `hono` | mcp SDK 的 HTTP transport（本專案走 stdio） | 否 |

沒修 `react-router` 的 RSC CSRF 通報：修補版是 8.3.0、7.x 無修補版，等於跨大版本。
`client/src/main.jsx` 只用 `BrowserRouter`，沒有 RSC、data router、loader、action，
該路徑在此不存在。判定為打不到、不值得跨大版本，`npm audit` 會持續顯示這一條。

沒改的檔（刻意）：
```
client/src/pages/System/broadcast-payload-validate.js — 它的 target_users_invalid 分支從此不可能被 UI 觸發，
                                                        但它是伺服器規則的鏡子，留著、測試也留著
src/routes/broadcast.js                              — API 契約完全沒動，伺服器收到的東西跟以前一樣
```

這一版學到的：

- **寫進待辦的「需要新增 X」如果沒查證，就是一個假設。** 待辦第 6 條寫著要新增一支查成員的 API，實際上 `/api/admin/users` 早就存在、也早就有三個頁面在用。花三分鐘查，省掉一支路由。
- **好的介面會讓一整條驗證路徑消失，而不是多一條。** 收件人改成從名單挑之後，「填了非整數」這件事在 UI 上不可能發生，所以不是多寫一個檢查，是那個檢查用不到了。
- **時間的測試不要寫死時區。** 斷言寫成「差距大約 30 天、時分不變」而不是某個字串，換台機器跑才不會紅。而那條「時分不變」要在 `TZ=America/New_York` 底下才驗得出紅綠 —— 本機在台北，沒有日光節約，兩種寫法都會過。
- **`Number(x) || 預設值` 在 0 是合法值的地方一律是錯的。** cooldown 那條藏了三個版本，是把送出邏輯抽出來寫測試才浮出來的。抽函式的價值不只在於好測，在於它逼你把每個欄位唸過一遍。
- **審查者標的嚴重度要自己重判。** 這次五條全中，但一條 Critical 其實是既有 bug、另一條 Critical 有繞路可走。照單全收會把「既有問題」寫成「這次改壞」。

## 整理 — 修掉兩個既有的死連結（housekeeping，無版號）

> 歸檔完做的全域掃描：FILELIST 與 CHANGELOG 裡共 57 個 openspec 路徑指不到東西。
> 其中**只有 2 個是真的可點的 markdown 連結**，也就是慣例第 4 段所說「會 404 的真壞連結」
> 那個例外，這次修掉。其餘 55 個是純文字檔案列表，第 4 段明講路徑或資料夾名過期不算
> 壞連結、不必追改，維持原樣當歷史紀錄。
>
> - `v1.20-iron-rule-enforcement` 這個資料夾名從來沒進過 archive。它在 v1.20 計畫拆成
>   v1.19.20~24 時就改過兩次名（→ `v1.19.20-rule-enforcer-core` →
>   `v1.19.20-iron-rule-enforcement-finishing`），FILELIST 當初補 `archive/` 前綴時
>   照著舊名補，等於補出一個從不存在的路徑。改指真正的資料夾，並標註原名。
> - `v1.17.66-windows-hardening` 單純漏了 `archive/` 前綴，資料夾同名還在。

修改：
```
FILELIST.md    — 2 行改指 archive/v1.19.20-iron-rule-enforcement-finishing/
CHANGELOG.md   — 2 個連結：同上，以及補 archive/v1.17.66-windows-hardening/ 的前綴
```

## 整理 — 22 個已發布的 OpenSpec 提案歸檔（housekeeping，無版號）

> `openspec/changes/` 底下堆了 22 個早就發布的變更資料夾沒搬進 `archive/`，從 v1.26.32
> 一路堆到 v1.26.61，含已完結的 `single-console-consolidation` 傘狀計畫。全部符合
> CONVENTIONS.md 第 2 段的歸檔條件（CHANGELOG 有對應版本條目；v1.26.32～35 沒有
> 獨立 tag，是跟 v1.26.36 同批發出去的）。照第 3 段用 `git mv` 搬、資料夾名都對得上
> proposal 標題所以不需正名，第 5 段的殘留檢查為零。
>
> 傘狀計畫裡還有 12 條沒做完的待辦，搬進 archive 就會被凍結（第 4 段），所以**鏡射**一份
> 到新的 `openspec/BACKLOG.md`。原檔的未勾項目不刪 —— 那是當時真的沒做的紀錄，刪掉等於
> 竄改歷史。改成在原檔頂端加一段導覽，講明「這裡是凍結紀錄、live 清單在 BACKLOG.md」。

新增：
```
openspec/BACKLOG.md                — 變更資料夾指認出來、刻意沒做、目前仍開著的工作
                                      分三區：要自己一個 release 的 / 等 Vin 決定的 / 小掃除
                                      每條標明出處，移除時要在 commit 訊息寫是做掉還是放棄
                                      第 6 條是這次新增的（Vin 看正式機廣播視窗提的兩點）
```

搬遷（`git mv`，22 個資料夾）：
```
openspec/changes/{v1.26.32…v1.26.61 共 21 個, single-console-consolidation}
  → openspec/changes/archive/ 底下同名
```

修改（路徑同步，共 70 處）：
```
FILELIST.md                        — 53 處歷史條目的路徑改指 archive/
CHANGELOG.md                       — 2 處
src/app.js                         — 2 處註解引用
src/routes/admin.js、src/middleware/first-run-redirect.js、
src/utils/spa-shell.js、src/utils/memory-search-query.js  — 各 1 處註解引用
client/src/pages/Admin/{menu-visibility,user-merge}.js    — 各 1 處註解引用
tests/{first-run-redirect,session-log-args,spa-deep-link-base,
       stage-1b-flip-root-retire-me,team-install-prompt,
       team-menu-visibility}.test.js                      — 各 1 處註解引用
legacy/me-v1.19/index.html         — 封存時加的導覽註解。凍結政策保護的是歷史內容，
                                      這行的用途是告訴讀者東西搬去哪，路徑失效等於註解廢掉
openspec/changes/archive/single-console-consolidation/tasks.md
                                   — 頂端加封存導覽（同上理由）：未勾的框是「當時刻意沒做」
                                      的紀錄不是漏掉的工作，還開著的那些看 BACKLOG.md
```

> 對抗審查（agy / Gemini 3.1 Pro High）回 2 Critical、3 Important、2 Minor。逐條回原始
> 資料查過：
> - **Critical「50 幾個未發布提案被誤搬進 archive」—— 駁回。** 它拿「archive 只有 PR #37
>   搬過 3 個」當前提去反推，但 `git ls-tree -d HEAD openspec/changes/archive/` 量到搬遷前
>   就有 55 個，55 + 22 = 77，數字完全對得上。這是只看 diff、看不到搬遷前狀態造成的假陽性。
> - **Critical「原檔沒刪等於重複計算」—— 成立，已處理。** 改成明講鏡射不是搬移，並在原檔
>   頂端加導覽。原檔不刪的理由寫進兩邊。
> - **3 條 Important 萃取失真 —— 全部成立，已照原文補回。** 第 4 條漏掉「只有一列在動＝
>   排程掃描器死了但 MCP 還活著」這個判斷結論跟建議做法；第 8 條漏掉 Requirement 3 沒預料到
>   這個張力；第 9 條的撤銷那半句原文沒有，改成標明是本次觀察、不是原條目的宣稱。
> - 2 條 Minor 是確認不是缺陷（legacy 註解修改正當、第 3/4/5 段有遵守）。

## v1.26.61 修改（Eric 回報 #9：少一個 model 不該讓整份工作紀錄消失）

新增檔：
```
mcp/lib/session-log-body.js       — 決定一份工作紀錄可以缺什麼。tool 自己填、model 不編、summary 不給預設
src/utils/session-buckets.js      — 空的 tool／model 歸到「未回報」，不要變成一個叫 null 的圖表分類
tests/session-log-args.test.js    — 15 項，含重現 Eric 那次「只有 summary」的呼叫
openspec/changes/archive/v1.26.61-log-session-required-args/proposal.md
```

修改檔：
```
mcp/index.js                      — log_session 只剩 summary 必填；confirm_string 說明改成請 AI 把「送出」唸給使用者聽、但照樣禁止自己填
src/routes/session.js             — POST /api/session 只要求 summary（資料表本來就允許空值，是 API 比自己的表還嚴）
src/routes/activity.js            — 兩處分組改用 bucketLabel
tests/required-args.test.js       — 一個測試名稱會誤導（它叫「the actual bug」，但那個 bug 已經不是那個形狀了）
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md, package.json — v1.26.61
```

這一版學到的：

- **同一個形狀第三次出現，就不要再改訊息了。** 前兩次的修法是「把錯誤訊息寫得更清楚」，第三次照樣發生、而且對方重試三次都沒救回來。IR-027 的實例：提醒無效，邏輯才有效。
- **「必填」要問它保護了什麼、代價是什麼。** 這裡是為了一個欄位丟掉整份紀錄，而那個欄位本來就沒有。划不來。
- **放寬一個欄位會把「沒有值」推到下游。** 改成選填的同一版就要處理它會在哪裡冒出來，不然就是在修一個 bug 的同時種一個新的。

## v1.26.60 修改（收尾，整併第 8 站；單一後台整併結束）

刪除檔：
```
src/routes/usage/pricing.js, src/utils/pricing-lookup.js, tests/pricing.test.js — 成本計算（Requirement 8）
src/routes/usage/exemptions.js, tests/exemptions.test.js                        — 沒有介面的 CRUD，正式機 0 筆
client/src/components/common/Signpost.jsx                                       — 指路牌頁
client/src/api/legacy-handoff.js                                                — 把憑證交給舊後台的那段
```

搬移檔：
```
src/public/index.html → legacy/admin-v1.26/index.html                           — 舊後台原始檔，加保存說明，沒有 COPY 指到 legacy/
```

新增檔：
```
src/utils/audit-log.js                                                          — 稽核寫入器。從 admin.js 抽出來，因為現在兩個 router 都要用
scripts/ensure-console-build.js                                                 — npm start 前確認後台 build 存在，沒有就跑一次
tests/dockerfile-runtime-files.test.js                                          — start 會執行到的 scripts 檔必須進映像；legacy/ 不准進
tests/login-rate-limit.test.js                                                  — 真的打 4 次登入確認第 4 次被擋（不是比對原始碼有沒有掛）
openspec/changes/archive/v1.26.60-legacy-cleanup/                                       — proposal / tasks
```

修改檔：
```
shared/legacy-console-manifest.js        — 「還在舊後台」不再是合法狀態，寫進去伺服器開不起來（會變成無窮導向迴圈）
src/middleware/legacy-admin-mount.js     — 只剩導向一條路；那段送出整個 src/public 的靜態掛載刪除
src/app.js                               — /api/admin/login 的限流改掛 /api/me/login（真正在用的那支從來沒有防護）
src/routes/admin.js                      — POST /login 刪除；writeAuditLog 抽到 utils
src/routes/me.js                         — 登入補寫稽核紀錄（正式機 60 天 0 筆，因為沒人在寫）
src/routes/admin-iron-rule-upgrade.js    — 刪掉寫進「不存在的資料表」的稽核；有意義的那筆改寫到真的存在的表
src/jobs/usage-aggregation.js            — 不再算成本，cost_usd 寫 null；欄位保留
src/routes/usage/{index,stats,team-stats}.js, src/routes/me-narrative.js — 回應不再帶 cost_usd
client/src/{App,components/common/Sidebar}.jsx, api/{auth,legacy-keys,client}.js — 指路牌相關拆除
client/src/i18n/{zh,en,ja}.json          — signpost.* / legacy.tab.* / nav.still_in_legacy / kpi.api_cost 移除
src/public/setup.html                    — 「前往登入後台」原本指向從來不存在的 /admin/login
Dockerfile                               — 註解對齊現況；prestart 腳本進映像（避免有人把 CMD 改成 npm start 就炸）
package.json                             — prestart 掛上；版號 1.26.59 → 1.26.60
openspec/changes/archive/v1.20.4-legacy-retire/proposal.md — 標記 superseded，對照表寫清楚每一項最後在哪一版真的做掉
```

這一版學到的：

- **決定要有數字撐。** 四個「要問 Vin」的項目，全部先去正式機量過再問。結果有兩個把預設答案推翻了：登入稽核看起來像「刪掉就沒了」，實際上 60 天 0 筆、兩個月前就斷了；鐵律升級看起來像沒人用的死程式，實際上它報的遷移 109 條裡有 72 條沒做完。
- **刪東西的時候會撞見旁邊的洞。** 這一版真正的資安修正不是刪成本 API，是發現新後台的登入從 v1.20 起就沒有防暴力破解 —— 舊的有，搬家的時候沒跟著搬，而且沒人發現。刪一支端點逼你去看它到底做了什麼。
- **「不再使用」跟「不可能再回來」是兩回事。** 靜態掛載沒被裝上，但改一個字就會回來。把那個狀態變成開不起來的錯誤，比刪掉程式碼更有用。

## v1.26.59 修改（週報月報搬進新後台，整併第 7 站，舊後台退場）

新增檔：
```
client/src/pages/Portal/PeriodicReportsPage.jsx                     — 週報月報頁：週/月切換、往回三期、三張卡、兩份清單
client/src/pages/Portal/periodic-report-vm.js                       — 純函式：四種「空」的分辨、保留期限判定、卡片值
client/src/pages/Portal/MemorySearchModal.jsx                       — 點清單搜尋相關記憶（從舊後台搬過來）
client/src/pages/login-outcome.js                                   — 登入回應三種結果（成功／要設定密碼／失敗），順序寫反會 prime 出一個沒有身分的 session
src/utils/setup-recovery.js                                         — 誰會被提供設定密碼表單，以及三種登入失敗共用的那一句話（訊息不同等於在洩漏哪些 Email 是真帳號）。獨立成純函式，因為這是安全決策
tests/periodic-report-vm.test.js                                    — 22 項，四種空狀態各自可分辨、保留期限含跨界與無法解析
tests/setup-recovery.test.js                                        — 11 項，伺服器端「誰能拿到 requiresSetup」＋前端三種結果
openspec/changes/archive/v1.26.59-periodic-reports/                         — proposal / spec / tasks
```

修改檔：
```
src/utils/report.js                                                 — 補 sessions_analyzed；拿掉寫死的 friction_issues_created（路由才算得出來，回傳 0 會讓忘記覆寫的呼叫端publish一個自信的錯數字）
src/routes/session.js                                               — 一句 SQL 用 FILTER 同時算 friction/suggestion 兩種自動建立；另一句分開算「還在的」跟「已被壓縮的」session 筆數；回傳 period_start/period_end/detail_retention_cutoff
src/routes/me.js                                                    — 密碼是 NULL 時改用 setup-recovery 判斷，超管在救援視窗內回 requiresSetup
client/src/pages/LoginPage.jsx                                      — 多一條設定密碼的路，收尾 scripts/reset-admin-password.js 開始的救援
src/middleware/first-run-redirect.js                                — 已裝好時 /setup 導去 dashboard/login，原本寫的 admin/login 從來就不存在
client/src/utils/request-gate.js                                    — 從 pages/Team/ 搬到 utils/（第三個使用者出現，不再是 Team 專屬）
client/src/App.jsx, components/common/nav-sections.js               — 掛上真頁面；權限從 admin 降回 user（它本來就是個人資料）
shared/legacy-console-manifest.js                                   — periodic-reports → live。清單空了，/admin 自己停止服務
client/src/i18n/{zh,en,ja}.json                                     — periodic.* 27 鍵 + login.setup* 6 鍵
scripts/reset-admin-password.js                                     — 救援步驟 2 不再叫人開 /admin/setup
tests/e2e/harness.mjs                                               — 多種一個沒有密碼的超管帳號 + 設 SETUP_TOKEN，讓救援路徑可以真的跑一次
tests/e2e/console.spec.mjs                                          — 退場鏡像 spec、週報月報 4 項、救援路徑 3 項；人數斷言改從 harness 推導
tests/{report,legacy-console-manifest,bare-mount-trailing-slash}.test.js — 對應新行為
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.59 條目、版號 1.26.58 → 1.26.59、救援指示改寫
package.json                                                        — 版號 1.26.58 → 1.26.59
```

這一版學到的：

- **「查詢寫錯」跟「沒有查詢」要分清楚**。母計畫寫的是「計數的 SQL 條件寫錯」，實際去讀程式碼發現後端從來沒有輸出過那個欄位。修法完全不同：一個是改條件，一個是補一段對稱的計數。先量再修，不要照著待辦的描述動手。
- **退場不是只有「不服務」這件事**。舊後台是唯一能收尾「超管忘記密碼」救援流程的介面。母計畫把這件事列在第 8 站的第一條、寫著「先做這個」，但第 8 站在退場之後 —— 順序本身就錯了。這一版把它提前，不然這個版本會帶著一個「唯一超管鎖死就再也進不來」的洞上線。
- **e2e 種子人數不要寫死**。加一個 fixture 帳號打掉兩個斷言。改成從 harness 推導出來，斷言仍然有效（頁面數錯還是會紅），但不必手改。
- **「防止舊回應寫進來」跟「切換當下不要顯示舊資料」是兩件事**。request-gate 只擋前者。下拉選單一改，畫面上的數字還是上一期的，這是同一個 Critical 的溫和版本。兩道防線各自被 mutation 測過，拿掉任何一道會有不同的 e2e 變紅。
- **對抗審查說「Critical」也要查**。這次兩個 Critical 裡有一個是錯的（說少了 import，實際上第 5 行就有）。審查者只看得到 diff，看不到檔案其他部分。先回檔案確認再動手，不要照著改。

## v1.26.58 修改（團隊用量搬進新後台，整併第 6 站）

新增檔：
```
client/src/pages/Team/TeamUsagePage.jsx                             — 排行榜頁：兩支 API、覆蓋率面板、成員明細開合
client/src/pages/Team/TeamUsageTable.jsx                            — 排行榜表格，9 欄（舊的 13 欄）
client/src/pages/Team/MemberDetail.jsx                              — 成員明細：總計卡、用量分佈、最近對話
client/src/pages/Team/team-usage-vm.js                              — 列的 view model、排序、覆蓋率、台北日界
client/src/pages/Team/member-detail-vm.js                           — 明細的 view model：總計卡、分佈長條、對話列
tests/team-usage-vm.test.js                                         — 21 條
tests/member-detail-vm.test.js                                      — 17 條
```

修改檔：
```
src/routes/usage/team-stats.js                                      — 覆蓋率改從 users 陣列算，心跳查詢整段刪掉
src/routes/usage/stats.js                                           — totals 補 has_usage_data（row_count 不外流）
src/app.js                                                          — API 速率上限可用 API_RATE_LIMIT_MAX 調整
src/public/index.html                                               — 舊頁面的 renderCoverage 跟著新的回應格式
shared/legacy-console-manifest.js                                   — team-usage: signpost → live，只剩一個指路牌
client/src/App.jsx                                                  — /team/usage 接上真的頁面
client/src/utils/fmtDate.js                                         — 抽出 bcp47Of()，數字格式跟著介面語系
client/src/i18n/{zh,en,ja}.json                                     — team_usage.* 72 個 key ×3 語系
tests/{team-stats,stats,legacy-console-manifest}.test.js            — 跟著改
tests/e2e/console.spec.mjs                                          — 團隊用量 6 條
tests/e2e/harness.mjs                                               — 測試機速率上限放寬
.env.example                                                        — API_RATE_LIMIT_MAX
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.58 條目、版號 1.26.57 → 1.26.58
package.json                                                        — 版號 1.26.57 → 1.26.58
openspec/changes/archive/single-console-consolidation/tasks.md              — Stage 6 收尾
```

**選擇說明**：

- **覆蓋率從畫面上那張表算出來，不是另外查一次**。心跳只證明收集器連上了，證明不了它送了東西；正式機實測回報 8/9，實際 3 人完全沒資料。同一份資料算兩件事，面板跟排行才不會各說一套。
- **沒有資料的列排在最後，不是當成 0**。標記它們的重點就在這裡：我們沒有資料的人，不可以排在真的做了 0 件事的人後面，好像兩者是同一種觀察。
- **成本欄是刪掉，不是留空**。理由見 CHANGELOG；排序選項因此改成依用量。
- **明細的對話清單跟總計一起抓**。舊頁面做成點「展開」才載入，省一次查詢，代價是一份要在三個地方失效的快取（換日期、換成員、重新載入）。一起抓之後，展開只是顯示跟隱藏。
- **兩支 API 缺資料的意思不一樣**。team-stats 是 users 的 LEFT JOIN，每個人都有列；team-overview 是 session_logs 的 inner join，只有有對話的人才在。所以「沒回報用量」跟「沒有對話紀錄」分開講、分開顯示原因。
- **換成員用 key 重新掛載，不是逐一清狀態**。code review 抓到「前一個人的數字掛在後一個人名字下」，跟 v1.26.56 那個 Critical 同一類。用 `key={selected.id}` 讓 React 直接換一個新的，整類問題（快取、日期、展開狀態）一起消失，不必記得清四個地方。
- **「按對話」改照 token 排序**。原本照 `SUM(cost_usd)`，正式機上有資料的人 cost 全 null，所以每組同分、`LIMIT 100` 留哪一百筆由資料庫決定。

## v1.26.57 修改（修少尾斜線會掉出 /ownmind 前綴）

新增檔：
```
src/middleware/bare-mount-redirect.js                               — 裸 mount 路徑轉到自己的目錄、用相對 Location
tests/bare-mount-trailing-slash.test.js                             — 20 條，全部對兩個 base 各解析一次
openspec/changes/archive/v1.26.57-bare-mount-trailing-slash/{proposal,spec,tasks}.md
```

修改檔：
```
src/app.js                                                          — /dashboard static 之前先掛 redirectBareMountPath
src/middleware/legacy-admin-mount.js                                — /admin static 之前同樣處理
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.57 條目、版號 1.26.56 → 1.26.57
package.json                                                        — 版號 1.26.56 → 1.26.57
```

**選擇說明**：

- 壞掉的轉址不是本專案寫的，是 `express.static` 內建 `redirect: true` 發的，所以 v1.26.48 那批「把自己寫的轉址改相對」碰不到。守衛掛在 static 前面、讓 serve-static 沒機會發，而不是關掉它的功能。
- **不能只加 `{ redirect: false }`**：`/dashboard` 會落到 SPA shell handler，`<base href>` 深度算錯 → v1.26.44 的白畫面。
- **用 middleware 不用 `app.get(mountPath)`**：Express 預設非嚴格路由，`app.get('/dashboard')` 也會吃到 `/dashboard/`，把它導向相對的 `dashboard/` 會解析成 `/dashboard/dashboard/` —— 無限迴圈，比原 bug 更糟。
- **守衛的匹配面必須至少跟被守衛者一樣寬**。第一版分大小寫、比對原始字串，結果 `/Dashboard`、absolute-form 請求行、非 GET 三種形狀都溜過去掉回絕對轉址。改成正規化 pathname + case-fold + 方法過濾。深度也從正規化 pathname 算，不然 absolute-form 會被當兩層深。
- `MOUNT_PATH` 收緊到 `/^\/[A-Za-z0-9][A-Za-z0-9._~-]*$/`：`/` 會讓根轉向自己、`/..` 會產生 `../` 的 target。這些都是寫死常數裡的手誤，值得在開機就炸掉（同 `shared/legacy-console-manifest.js` 的理由）。
- 測試檔的 `srv.close()` 會等現有連線結束，光 destroy 用戶端不夠、要 `closeAllConnections()`，否則整檔被判 cancelled。

## v1.26.56 修改（統計儀表板搬進新後台 — 整併第 5 站）

新增檔：
```
client/src/pages/Team/StatsPage.jsx                                 — 控制列（使用者／時間範圍）+ 兩種檢視分岔
client/src/pages/Team/StatsOverview.jsx                             — 用戶活躍度總表（八欄）
client/src/pages/Team/StatsDetail.jsx                               — 單一使用者的 17 個區塊
client/src/pages/Team/charts.jsx                                    — BarChart / DailyChart / Card / ChartPair / 顏色分帶
client/src/pages/Team/stats-overview-vm.js                          — 總覽列 view-model（七天窗、pill 排序、null 落地率）
client/src/pages/Team/stats-chart-data.js                           — 長條圖與每日圖的比例計算（含除以零的守衛）
client/src/pages/Team/stats-compliance-vm.js                        — 落地率分帶、各規則／各工具、每條鐵律、從未觸發
client/src/pages/Team/stats-detail-vm.js                            — 記憶卡片、系統健康、交接、工作脈絡
client/src/pages/Team/stats-labels.js                               — 事件／類型標籤走字典查表、查不到回原字串
client/src/pages/Team/request-gate.js                               — 只有最新的請求可以寫狀態（修 code review 的 Critical）。v1.26.59 搬到 client/src/utils/
tests/stats-overview-vm.test.js                                     — 14 assertions
tests/stats-chart-data.test.js                                      — 10 assertions
tests/stats-compliance-vm.test.js                                   — 22 assertions
tests/stats-detail-vm.test.js                                       — 14 assertions
tests/stats-labels.test.js                                          — 7 assertions（含三語系 key 對齊、en 不得殘留漢字）
tests/stats-request-gate.test.js                                    — 5 assertions（含重現整頁空白的順序）
openspec/changes/archive/v1.26.56-stats-dashboard/{proposal,spec,tasks}.md   — 8 條需求含 GIVEN/WHEN/THEN
```

修改檔：
```
client/src/App.jsx                                                  — import StatsPage、REAL_PAGES 加 /team/stats
shared/legacy-console-manifest.js                                   — stats-dashboard signpost → live（剩 2 個指路牌）
client/src/i18n/{zh,en,ja}.json                                     — 122 個 stats.* key、三語系同步
src/routes/usage/team-stats.js                                      — loadUsersAggregate 加 has_usage_data（tier1 有列 OR tier2 有列）
client/src/pages/Admin/user-merge.js                                — 依 has_usage_data 判定未量測；顯示數字改讀 session_count
tests/legacy-console-manifest.test.js                               — v1.26.56 flip 斷言、指路牌數 3 → 2
tests/team-stats.test.js                                            — has_usage_data 三種情形（有回報的 0／完全沒列／只有 tier2）+ null flag 防禦
tests/team-user-merge.test.js                                       — fixture 改用 session_count；加只有 tier2 的成員案例
tests/e2e/console.spec.mjs                                          — 修 4 支長期紅掉的測試；新增 5 支統計頁測試
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.56 條目、版號 1.26.55 → 1.26.56
package.json                                                        — 版號 1.26.55 → 1.26.56
openspec/changes/archive/single-console-consolidation/tasks.md              — Stage 5 勾完
```

**選擇說明**：

- **「沒量到」不能畫成紅色 0%**。舊頁的各規則／各工具落地率是 `t > 0 ? 算 : 0` 之後再分帶，本期沒有任何合規事件的規則因此被畫成滿格紅色 0%。null 現在走自己的分帶、不給顏色也不畫條。這是 umbrella Requirement 7 的核心，也是這一站主要的行為修正。
- **「尚無數據」拆成具名原因**。落地率算不出來、本期沒有 session、沒觀察到 init 事件，原本共用一個標籤，四種不同的成因變成同一句話。現在各有自己的說明句。
- **工作脈絡四塊不整段消失**。舊頁 `context: null` 直接 `classList.add('hidden')`，看的人分不出功能壞了還是沒資料。四張卡片現在一定在。
- **`initRateMeasured` 為什麼是可靠的推論而不是猜**：`by_event` 是 `GROUP BY event ORDER BY count DESC LIMIT 20`，不到 20 筆就代表沒有被截斷，缺 key 就是真的沒發生。到 20 筆就無法證明、退回信任伺服器（也就是維持現狀、絕不會比原本更差）。
- **`bool_or(d.id IS NOT NULL)` 回 FALSE 不是 NULL** — 用 postgres:16 實測過，不是推的。三值邏輯的直覺答案（null）是錯的。
- **e2e 指路牌測試刻意不按角色過濾**：第一版寫「取第一個 minRole 等於 admin 的」，那會在剩下的指路牌都不在 admin 層那天回傳 null、三支測試靜靜被 skip，而舊後台還在服務。那正是這批要修的同一種毛病。改成取第一個、登入帳號由它自己的 minRole 決定，只有完全沒有指路牌時才 skip。
- **race guard 抽成模組而不是留兩行 `if`**：這個 repo 沒有 CI，藏在 JSX 裡的判斷只能被斷言、不能被執行。`request-gate.js` 讓「整頁變空白」那個順序有一支真的跑得起來的重現測試。
- **已知限制**：`getContextAnalysis` 是 `catch { return null }`，「真的沒資料」跟「查詢炸了」到前端都是 `context: null`。頁面寫的是前者，那是比較可能的解讀、不是證明。要分辨得動端點。
- 記憶搜尋 modal **不屬於這一站**：`data-search-text` 只出現在 `:2750` 與 `:2761`，兩處都在 `loadReport()`（週／月報 tab）內。umbrella tasks 把它列在 Stage 5 是寫錯了。

## v1.26.55 修改（修備份成功卻回報失敗）

修改檔：
```
scripts/backup-db.sh                                                — cleanup trap 拿掉多餘的 [ -f ] 測試（它的 false 狀態會蓋掉腳本退出碼）
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.55 條目、版號 1.26.54 → 1.26.55
package.json                                                        — 版號 1.26.54 → 1.26.55
```

**選擇說明**：

- 成功路徑上 `` 已經被 mv 走，`[ -f "$TMP" ]` 為 false 回傳 1；它是 trap 的最後一個指令，狀態就成了整支腳本的退出碼。`rm -f` 對不存在的路徑本來就回 0、那個測試從頭到尾多餘。
- 為什麼這條要當 bug 修而不是「小瑕疵」：cron 會把每次成功備份都當失敗告警。讓告警天天響，是最快讓所有人學會忽略它的方法 — 真的失敗那天，那封信跟前面 30 封長得一樣。
- 兩次實跑抓到兩個 bug，都不是讀程式碼看得出來的。第二個尤其要**去看退出碼、而不是只看 log 有沒有印 ok** 才抓得到。

## v1.26.54 修改（修備份腳本的 pipefail 誤判）

修改檔：
```
scripts/backup-db.sh                                                — schema 檢查改成暫時關掉 pipefail、判 grep 自己的退出碼
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.54 條目、版號 1.26.53 → 1.26.54
package.json                                                        — 版號 1.26.53 → 1.26.54
```

**選擇說明**：

- 為什麼要關 pipefail：`grep -q` 一命中就結束、關掉管線，上游的 gunzip 收到 SIGPIPE 死於 141，pipefail 把 141 當成整條管線的結果。PIPESTATUS 實測 `[141, 0]` — grep 自己是成功的。
- 為什麼這比一般 bug 危險：它是競爭條件。gunzip 有沒有在 grep 關管線前寫完取決於檔案大小跟 page cache，小檔會過、真實 34MB dump 會掛。第一次隔離重現時是 PASS 的、差點誤導我往別的方向查。
- 為什麼不改用 `grep -c`：`-c` 會讀完整個串流所以沒有 SIGPIPE 問題，但要付出解壓完整 34MB 的代價。關掉 pipefail 保留 `-q` 的提前結束、檢查一秒內就跑完。
- 為什麼開新的 v1.26.54 而不是移動 v1.26.53 的 tag：tag 已經推上去了，移動它會變成兩棵不同的樹都自稱 v1.26.53。這個 repo 本來就有實測抓到 bug 就開新 patch 的前例（v1.26.47）。

## v1.26.53 修改（正式機資料庫每日備份）

新增檔：
```
scripts/backup-db.sh                                                — 跑在伺服器上的每日 pg_dump。原子性寫入（先 .tmp 驗過才 mv）、三道驗證（gzip 完整性 / 大小下限 / grep CREATE TABLE）、輪替只刪自己命名規則的檔、umask 077
```

修改檔：
```
.gitignore                                                          — 加 backups/ 跟 *.sql.gz（dump 檔含全部使用者 api_key 明文）
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.53 條目、版號 1.26.52 → 1.26.53
package.json                                                        — 版號 1.26.52 → 1.26.53
```

**選擇說明**：

- 為什麼現在才做：2026-08-03 實測誤觸一次 PATCH 改到真實資料、想撈原值時才發現一份備份都沒有。那筆資料兩個欄位永久遺失。同一個資料庫裡放的是全團隊記憶、鐵律、加密金鑰 — 這次只丟一筆錯誤回報算便宜。
- 為什麼先寫 `.tmp` 再 `mv`：當機或磁碟滿留下的半截 dump 比沒有 dump 更糟 — 它看起來像備份、直到真的需要用它那天才知道是空的。
- 為什麼要 grep `CREATE TABLE` 而不只驗 gzip：`pg_dump` 連到空的或錯的資料庫會產出一個完全合法的小 .gz。「檔案存在而且解得開」證明不了它是有內容的備份。
- 為什麼輪替限定檔名 pattern：`find -delete` 配上一個被指錯的 `BACKUP_DIR` 就是一個刪檔腳本。限定 `ownmind-*.sql.gz` 讓它最多只能刪自己產的東西。
- **為什麼沒有單元測試**：這是一支對著 docker 講話的 bash 腳本、`node --test` 測不到有意義的東西。改用實跑驗證，三項都在正式機做過：(1) 正常跑產出可用 dump、(2) 故意指向不存在的資料庫確認會失敗且不留下檔案、(3) 把 dump 實際還原到拋棄式資料庫確認內容完整。驗證細節見 CHANGELOG 跟本次 session 紀錄。

## v1.26.52 修改（修表格右側欄位被裁掉、按鈕點不到）

新增檔：
```
tests/console-table-overflow.test.js                                — 3 條斷言：沒有表格卡片是 overflow-hidden、每個都有宣告 overflow 行為、helper 至少找得到 10 個 wrapper（防假綠）
```

修改檔：
```
client/src/pages/Admin/BugReportsPage.jsx                           — 兩個表格 wrapper overflow-hidden → overflow-x-auto
client/src/pages/System/BroadcastPage.jsx                           — 同上
client/src/pages/System/SystemConfigPage.jsx                        — 同上
client/src/pages/System/WorkLogPage.jsx                             — 同上
client/src/pages/Portal/UsageMine.jsx                               — 四個 wrapper、既有問題順手修
client/src/pages/Portal/UsageTeam.jsx                               — 三個 wrapper、既有問題順手修
client/src/pages/Portal/UsageProjects.jsx                           — 一個 wrapper、既有問題順手修
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.52 條目、版號 1.26.51 → 1.26.52
package.json                                                        — 版號 1.26.51 → 1.26.52
```

**選擇說明**：

- 為什麼 TeamPage 不一起改：那頁每列有 RowMenu 下拉選單、需要溢出卡片才看得到。改成 `overflow-x-auto` 會變成裁掉選單而不是裁掉欄位、等於用一個點不到的東西換另一個。所以保持 `overflow-visible`、測試也明確允許這個選項並寫明理由。
- 為什麼順手修 Portal 三支：同一個 pattern、同一個 bug、只是還沒有人在會裁的視窗寬度下用過。既然卡控是掃全 `client/src/pages`、不修就是留三個假綠的例外。
- 為什麼容忍原始碼字串斷言：node --test 沒有 render 環境、class list 本身就是全部的行為。跟 `legacy-console-manifest.test.js` 裡那條「app.js 不准直接 mount /admin」同一類。已用突變測試驗過會爆。
- 這條卡控的已知極限：只涵蓋用慣用類名（`border-slate-200` + `rounded-xl`）的表格卡片。寫法不同的列表逃得掉。這在測試檔的註解裡寫明、不假裝是完整證明。

## v1.26.51 修改（錯誤回報＋工作紀錄搬到新後台 — 單一後台整併階段 4）

新增檔：
```
openspec/changes/archive/v1.26.51-bug-reports-work-log/proposal.md          — change folder。兩頁的權限對照、封鎖期內使用者 card 為什麼不搬、pure fn 抽出策略
openspec/changes/archive/v1.26.51-bug-reports-work-log/spec.md              — 8 個 requirement 加 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.26.51-bug-reports-work-log/tasks.md             — 6 個 phase 的實作進度
client/src/pages/Admin/BugReportsPage.jsx                           — 錯誤回報主頁。兩張 stat card、兩個子分頁、status filter、reports 表 + spam 表
client/src/pages/Admin/BugReportDetailModal.jsx                     — 詳細 modal。完整欄位 + conversation_snippets 三種 shape 渲染 + 狀態編輯器 + wontfix 分支
client/src/pages/Admin/SpamSuspectModal.jsx                         — spam 確認 modal。紅色確認、灰色取消、遠離擺放
client/src/pages/Admin/bug-report-row-vm.js                         — 純函式：bugReportRowVm(row, userMap)。severityColor / statusColor / userLabel 有 fallback / createdAtLabel minute 精度
client/src/pages/Admin/bug-status-update-validate.js                — 純函式：validateBugStatusUpdate(form)。鏡射伺服器 status 列舉 + wontfix reason 必填 + wontfix_other note 必填
client/src/pages/System/WorkLogPage.jsx                             — 工作紀錄主頁。六個篩選、三來源時間軸、offset 分頁、載入更多
client/src/pages/System/work-log-query.js                           — 純函式：buildWorkLogQuery(filters, offset, limit)。空值省略、YYYY-MM-DD 廣化為全日 ISO
client/src/pages/System/work-log-row-vm.js                          — 純函式：workLogRowVm(row)。三來源顏色、空 details 顯示 —、summary 勝過 details、200 字截斷
tests/bug-report-row-vm.test.js                                     — 12 條斷言 severity / status / user resolution / timestamp slice / component fallback
tests/bug-status-update-validate.test.js                            — 12 條斷言 status 列舉 / wontfix reason 必填 / wontfix_other note 必填 / 非 wontfix 忽略 reason
tests/work-log-query.test.js                                        — 11 條斷言 分頁常存在 / 日期廣化 / 空文字略過 / q 去空白 / 型別強制字串
tests/work-log-row-vm.test.js                                       — 12 條斷言 source 顏色 / user fallback / 空 details / summary 勝 details / 200 字截斷 / tool 空值
```

修改檔：
```
client/src/App.jsx                                                  — REAL_PAGES 加 /admin/bugs 跟 /system/work-log、import 兩支頁面
client/src/api/index.js + client.js                                 — 加 apiPatch export、給 PATCH /:id/status 用
shared/legacy-console-manifest.js                                   — bug-reports 跟 work-log 兩條 state signpost → live、註解更新
tests/legacy-console-manifest.test.js                               — 加兩條斷言：v1.26.51 兩條都是 live、三個 signposts 還在
client/src/i18n/{zh,en,ja}.json                                     — 加 80 個 bug_reports.* / work_log.* keys（頁面標題、狀態、欄位、modal、錯誤訊息）
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.51 條目、版號 1.26.50 → 1.26.51
package.json                                                        — 版號 1.26.50 → 1.26.51
openspec/changes/archive/single-console-consolidation/tasks.md              — Stage 4 checkbox 打勾
```

**選擇說明**：

- 為什麼舊卡片的第三張 stat card `封鎖期內使用者` 不搬：翻遍 `src/public/index.html` 沒有一行呼叫 `.textContent = ...` 給它、也沒有 GET 端點回這個計數。舊 UI 就是掛一個 `-` 佔位符然後永遠不動。Requirement 7 「不知道就不要畫、畫成 0 反而讓人誤以為今天沒人被封」直接適用。未來真要就加一支 `GET /api/bug-reports/spam-blocks/active-count`、這階段不假裝有。
- 為什麼要多加 `apiPatch()` 到 API 客端而不是用 fetch 硬幹：整個 codebase 都走 `apiGet/apiPost/apiPut/apiDelete` 統一封裝、有 401 debounce、有 base URL 拼接、有 Bearer 自動加。多一支 PATCH 只是把封裝補齊、不要在一個地方例外。
- 為什麼把純函式抽四支獨立檔：這個 repo 沒有 React 測試環境、Node --test 只能測 pure module。四支抽出來讓核心邏輯有 47 條 unit test 撐、React 部分靠將來 Playwright e2e。
- 為什麼 details empty → `—` 而不是 `{}`：舊 JS 就是這規則（`src/public/index.html:2703-2707`）。原因：init 這種事件本來就不帶 payload、印 `{}` 是雜訊不是資訊。
- 為什麼 work-log 的 summary 勝過 details：session_logs 每列同時有 summary（AI 產出的摘要）跟 details（原始欄位），要看哪個 UI 才有用。摘要是給人看的、details 是 debug 用。頁面預設給人看、需要 debug 的人 hover title 可看完整 JSON。

## v1.26.50 修改（系統設定＋廣播管理搬到新後台 — 單一後台整併階段 3）

新增檔：
```
openspec/changes/archive/v1.26.50-system-config-broadcast/proposal.md       — change folder。三張 card 拆兩頁的權限對照、collector 靜默是 Requirement 7 首要應用場景、pricing 為什麼不搬
openspec/changes/archive/v1.26.50-system-config-broadcast/spec.md           — 7 個 requirement 加 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.26.50-system-config-broadcast/tasks.md          — 10 個 phase 的實作進度
client/src/pages/System/SystemConfigPage.jsx                        — 系統設定主頁。兩支 apiGet 平行、observedUsers 併、三狀態統計條 + 裝機表格
client/src/pages/System/BroadcastPage.jsx                           — 廣播管理主頁。列表、新增、撤銷 dialog、過期列 45% 透明、auto 廣播不畫撤銷鈕
client/src/pages/System/NewBroadcastModal.jsx                       — 新增廣播 modal。舊 modal 欄位一比一：type / severity / title / body / cta / target / snooze / cooldown / ends_at；送前先跑 client 端 validate
client/src/pages/System/RevokeConfirmDialog.jsx                     — 撤銷確認 dialog。紅色按鈕、遠離取消
client/src/pages/System/observed-users.js                           — 純函式：observedUsers(clients, stats) + rollupCounts(rows)。四狀態分類 + banner 統計 + 靜默點名
client/src/pages/System/broadcast-row-vm.js                         — 純函式：broadcastRowVm(row, now)。isActive / isRevocable / snoozeLabel / typeColor / severityColor / effectiveRange
client/src/pages/System/broadcast-payload-validate.js               — 純函式：validateBroadcastFormClient(form)。鏡射伺服器 validateBroadcastPayload、送前先擋
tests/observed-users.test.js                                        — 15 條斷言 flowing / silent / not_installed / offline 分類 + rollup + null stats 降級語意
tests/broadcast-row-vm.test.js                                      — 20 條斷言 isRevocable 對 is_auto / 過期 / 生效範圍字串 / snooze 標籤 / type & severity 顏色
tests/broadcast-payload-validate.test.js                            — 13 條斷言 title / body / type / severity / snooze / cooldown / ends_at / target_users 驗證
```

修改檔：
```
client/src/App.jsx                                                  — REAL_PAGES 加 /system/config 跟 /system/broadcast、import 兩支頁面
shared/legacy-console-manifest.js                                   — system-config 跟 broadcast 兩條 state signpost → live、註解更新
tests/legacy-console-manifest.test.js                               — 加兩條斷言：v1.26.50 兩條都是 live、五個 signposts 還在（如果未來手滑倒退成 signpost、這裡爆）
client/src/i18n/{zh,en,ja}.json                                     — 加 80 個 system.config.* / system.broadcast.* keys（頁面標題、狀態、欄位、modal、錯誤訊息）
CHANGELOG.md, README.md, docs/README.{zh-TW,ja}.md                  — v1.26.50 條目、版號 1.26.49 → 1.26.50
package.json                                                        — 版號 1.26.49 → 1.26.50
```

**選擇說明**：

- 為什麼銀行 pricing card 不搬：Vin 2026-07-30 拍板要把它跟背後的 `/api/usage/pricing` 一起在階段 8 直接刪掉、原因是每個 model 的價錢要人肉維護、其中一個沒填整欄就變 null（`src/jobs/usage-aggregation.js:123`）。這階段搬過來就是浪費工。
- 為什麼 collector 靜默要另外挑出來、不融進整體狀態：舊「已裝」計數把 heartbeat 有回應就當作 OK、把「連線活但完全沒資料」的死角藏起來。umbrella spec Requirement 7 就是專門修這個。點名而不是只給計數的原因是操作者要能直接找到誰是靜默、去問。
- 為什麼 stats fetch 失敗要降級成「大家都靜默」而不是「大家都正常」：Requirement 7 的精神是「不確定的時候不要偽裝成確定」。如果 stats 拉不到、把已裝的成員畫成正常等於在騙自己。降級成靜默、頁面繼續能用但操作者一看就知道有問題。`observed-users.test.js` 專門有一條 case 押這件事。
- 為什麼 auto 廣播不畫撤銷鈕：`src/routes/broadcast.js:165-169` 會拒 auto row 的撤銷 request、nightly job 隔天又會再生一次。畫按鈕給操作者是給他一個按了會被打回票的按鈕。
- 為什麼把 pure functions 抽三支獨立檔：跟 v1.26.49 同理 — 這個 repo 沒有 React 測試環境、Node --test 只能測 pure module。三支抽出來讓核心邏輯有 48 條 unit test 撐、React 部分靠將來 Playwright e2e。

## v1.26.49 修改（使用者管理搬到新後台 — 單一後台整併階段 2）

新增檔：
```
openspec/changes/archive/v1.26.49-team-management-page/proposal.md   — change folder。scope、四項 dropdown、為什麼保留 emergency endpoint 不接
openspec/changes/archive/v1.26.49-team-management-page/spec.md       — 8 個 requirement 加 GIVEN/WHEN/THEN
openspec/changes/archive/v1.26.49-team-management-page/tasks.md      — 9 個 phase 的實作進度
client/src/pages/Admin/TeamPage.jsx                          — 使用者管理主頁。兩隻 apiGet 平行、合併、顯示、單一管理者警告條
client/src/pages/Admin/RowMenu.jsx                           — 每列的操作 dropdown。click-outside / Escape 收起、動作可見性靠 visibleMenuItems 決定
client/src/pages/Admin/AddUserModal.jsx                      — 新增使用者 modal。form + 若 server 回 default_password 就切成一次性密碼面板
client/src/pages/Admin/EditUserModal.jsx                     — 改名字 / 角色 modal。走 PUT /api/admin/users/:id、email 唯讀
client/src/pages/Admin/PasswordModal.jsx                     — 改密碼 modal。self / super-admin-reset 兩個形狀分支
client/src/pages/Admin/DeleteUserModal.jsx                   — 確認刪除 modal。紅色 confirm、伺服器守門
client/src/pages/Admin/menu-visibility.js                    — 純函式：visibleMenuItems(actor, row)。抽出來為了不用 React 就能測條件
client/src/pages/Admin/user-merge.js                         — 純函式：mergeUsersWithUsage(users, stats)。missing 跟 zero 分開、cache tokens 排除
client/src/utils/install-prompt.js                           — 純函式：buildInstallPrompt(user, apiUrl) 跟 currentApiUrl(location)。字串跟舊 UI 一字不差
tests/team-install-prompt.test.js                            — 5 條斷言 install prompt 字串形狀、跟舊 UI parity
tests/team-menu-visibility.test.js                           — 12 條斷言 dropdown 條件、含 self / super_admin / admin 三種 actor 對三種 row
tests/team-user-merge.test.js                                — 11 條斷言 users + stats 合併行為、含「全 0 不等於 unmeasured」的邊界
```

修改檔：
```
client/src/App.jsx                                           — REAL_PAGES 加 /admin/team → TeamPage、import TeamPage from './pages/Admin/TeamPage'
shared/legacy-console-manifest.js                            — team-management state signpost → live。/admin/ 還在服務（六個 signpost 未動）
client/src/i18n/{zh,en,ja}.json                              — 加 45 個 team.* keys（欄位、按鈕、modal 標題、toast、錯誤訊息、common.* 補齊）
tests/e2e/console.spec.mjs                                   — 更新 3 支跟 /admin/team 是 signpost 有關的斷言（改用 /admin/bugs、還是 signpost）、加 3 支新斷言驗真頁面（欄位、尚無資料標示、sidebar 無琥珀小點）
package.json, README.md, docs/README.{zh-TW,ja}.md           — 版號 1.26.48 → 1.26.49
```

**選擇說明**：

- 為什麼把 install prompt 收進每列 dropdown、不留獨立摺疊區：舊 UI 那個摺疊區還要另外選使用者。既然每一列本來就對到一個 API Key、放回那一列少一步。字串本身照抄、跟舊版一字不差確認過。
- 為什麼把 pure functions 抽三支獨立檔（install-prompt、menu-visibility、user-merge）：這個 repo 沒有 React 測試環境（沒 jsdom、沒 Testing Library、沒 Vitest）、Node --test 只能測 pure module。抽出來三支之後、核心邏輯有 28 條 unit test 撐著、React 部分靠 Playwright e2e 驗（`tests/e2e/console.spec.mjs`、走真瀏覽器）。
- 為什麼「用量資料」欄的 unmeasured 判斷用「有沒有 stats row」而不是「總數是否為 0」：有可能成員這週剛好沒用 AI、但機器有回報 heartbeat。那個是 real zero、不是 unmeasured。差別是有沒有 stats row 存在。team-user-merge.test.js 專門用 `全 0 stats row` 這一條 case 抓這個差異。
- 為什麼 emergency reset-password endpoint 保留但 UI 不接：Vin 拍板、階段 2 先跟舊 UI 對齊、不引進新的安全流程。endpoint 沒動、將來哪一個 stage 專攻 account security 一起處理（proposal.md「Filed, not fixed here」有記）。

## v1.26.48 修改（根路徑翻到新後台、`/me/` 收掉 — 單一後台整併階段 1b）

**背景**：三個後台整併成一個的階段 1b。階段 1a（v1.26.46 / v1.26.47）已經把 `/me/` 用得到的功能全部搬進新後台、把還沒重建的舊 `/admin/` 功能都掛上指路牌，所以現在動根路徑是安全的。

新增檔：
```
openspec/changes/archive/v1.26.48-flip-root-retire-me/proposal.md       — 新增、change folder（背景、根因、選項比較、非目標）
openspec/changes/archive/v1.26.48-flip-root-retire-me/spec.md           — 新增、五個 requirement 加 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.26.48-flip-root-retire-me/tasks.md          — 新增、九個 phase 對照這次做的每一步
tests/stage-1b-flip-root-retire-me.test.js                      — 新增、11 條。起真實 src/app.js（照 v1.26.44 設 ENCRYPTION_KEY），用「把 Location 對兩個不同 base URL 解析、應該落在同一個終點」的方式驗、不用字串比對。三個 /me 請求形狀（無斜線、有斜線、深路徑）全驗過、加一條「/me/index.html 不能再回 200」防止靜態掛載偷偷復活、加一條結構性檢查「app.js 跟 first-run-redirect.js 的 res.redirect 裡不能有 /ownmind 字串」
legacy/me-v1.19/index.html                                       — 從 src/public/me/index.html 搬過來的保存快照。Dockerfile 沒有任何 COPY 拉 legacy/，所以正式機映像不會再打包這個檔。檔頭加了 HTML 註解說明「保存快照、不被任何路由服務」
```

修改檔：
```
src/app.js                                                       — 兩處硬編碼 /ownmind 絕對路徑改相對：根路徑從 `res.redirect('/ownmind/admin/')` 改成 `res.redirect(relativeRedirectTarget(req.originalUrl, 'dashboard/'))`；/me 條件式 handler + `express.static(src/public/me)` 靜態掛載整包換成 `app.use('/me', ...)` middleware，用 relativeRedirectTarget 算深度、301 到 dashboard/portal/usage
src/middleware/first-run-redirect.js                             — 加 `/` 攔截（以前只攔 /admin*、/setup；根路徑翻新之後全新安裝會跳過 middleware 直接到新後台）；兩處絕對 Location `/setup`、`/admin/login` 改用 relativeRedirectTarget
tests/first-run-redirect.test.js                                 — 兩條 scenario 從斷言絕對字串改成「解析後應該落在正確終點」；加 v1.26.48 scenario 4：first_run=true 時 `/` 走 setup、first_run=false 時 `/` 通過。fail-open 場景改用 `redirect === null` 而不是 `notEqual`
tests/me-report.test.js                                          — 三條讀 src/public/me/index.html 的測試刪掉；「serve /me 靜態頁」那條改成只驗 /api/me 還掛著（靜態頁已退役、行為由 stage-1b 檔覆蓋）
tests/me-pitfalls.test.js                                        — 讀 legacy HTML 驗 pitfalls 頁籤 wiring 的 describe 整塊刪除。API 端點測試在上面、沒動；console 端 wiring 屬於 client/src/pages/Portal/PitfallsPage.jsx 的測試領域
package.json, README.md, docs/README.{zh-TW,ja}.md               — 版號 1.26.47 → 1.26.48
```

搬移：
```
src/public/me/index.html → legacy/me-v1.19/index.html            — 舊 /me/ 靜態 UI 保存為歷史快照、搬出 src/ 避免被 Docker 打包進正式機。用 git mv 保留 history
```

刪除檔：
```
tests/me-trailing-slash.test.js                                  — 整份刪掉。測的條件式 `/me` → `me/` handler 已經不存在，新行為由 stage-1b-flip-root-retire-me.test.js 覆蓋。git history 保留
```

**選擇說明**：

- 為什麼不直接讓 `/` 302 到寫死的 `/ownmind/dashboard/`：nginx 會把 `/ownmind` 前綴切掉才轉發、Express 完全看不到。硬編碼 `/ownmind` 是賭部署拓撲，這個賭其他地方（v1.26.44 的 `<base href>`、legacy-admin-mount 的 301 目標）都已經不做了。相對路徑 `dashboard/` 兩種部署（有前綴、沒前綴）都對。
- 為什麼 `/me` 三種形狀不用同一個 Location：Express 的 `res.redirect(loc)` 是把 `loc` 原樣塞進 Location header、瀏覽器再按當前 URL 的目錄解析。`/ownmind/me`、`/ownmind/me/`、`/ownmind/me/foo` 的目錄不同，所以要往上退的層數也不同。`relativeRedirectTarget(req.originalUrl, target)` 從 originalUrl 算深度、逐次算對的層數。
- 為什麼 `/me` 用 `app.use('/me', ...)` middleware 而不是 `app.get('/me/*', ...)`：Express 5 已經拿掉裸的 `/me/*` 這種 unnamed wildcard 語法。這也是 v1.26.46 的 legacy-admin-mount 為什麼用 `app.use('/admin', ...)`：同一個模式套過來。
- 為什麼刪 me-trailing-slash 整份而不是改：整份測的都是條件式 `/me` → `me/` 這個特定 handler。它已經不存在，改任何一條都在維護死程式碼、不如全刪、新行為在 stage-1b 檔集中覆蓋。git history 找得到。
- 為什麼保留 `src/public/me/index.html` 而不是直接刪掉：階段整併程式的其他階段還沒動、萬一 CI/CD 需要對照舊 UI 的 markup 或字串找對照，保存快照有實務價值。位置放 `legacy/` 是跟 `/admin/` 之後要搬的位置一致、一眼看得出來是歷史保存區。

## v1.26.47 修改（AI 說明自己編人數 — v1.26.46 部署後實測抓到）

修改檔：
```
src/lib/llm-narrative.js                                         — 系統提示第 9 條改掉。v1.26.46 那版要模型「開頭先講『有 N 位成員從來沒有回報過』」，於是它不管實際有幾個都講這句、數字自己填：正式機九位成員全部有安裝、六位在用，它寫成「有 8 位成員從來沒有回報過任何資料」。我為了防一句有自信的假話而加的規則生產了一句有自信的假話。改成明確禁止它自己數人數、也禁止評論排名完整或不完整 — 介面本來就會用同一批資料算出精確人數，而且只在真的有人沒資料時才顯示
client/src/pages/Portal/AuditFindings.jsx                        — 補上另外兩種 finding 的標題（ir027_candidate / team_blindspot）。v1.26.46 我讀伺服器程式碼只看到前兩種就下結論、正式機一看是四種。畫面沒壞（退路把伺服器訊息當標題），但少了能快速掃過的標題。改用型別到字典鍵的對照表、不直接拼 `audit.finding.${type}`：其中一個型別名字裡帶個人鐵律編號，不該擴散到前端字典
client/src/i18n/{zh,en,ja}.json                                  — 新增兩個 finding 標題
tests/llm-narrative.test.js                                      — 新增 3 條：提示仍然解釋 measured 的意思、明確禁止數人數與評論排名完整性、而且那個會被填空的句型不能再出現。突變測試確認把舊句型放回去會變紅
package.json, README.md, docs/README.{zh-TW,ja}.md               — 版號 1.26.46 → 1.26.47
```

## v1.26.46 追加：端對端（e2e）測試

新增檔：
```
tests/e2e/harness.mjs                                            — 新增、丟棄式測試環境。開一個沒有 volume 的 pgvector 容器 + 用 node 直接跑 API（改程式不用重建映像），然後塞三個已知密碼、三種角色的帳號跟一筆孤兒 session。用丟棄式而不是開發環境：這套測試會建帳號，建在有真記憶的資料庫裡就會留垃圾。容器停掉資料就一起消失
tests/e2e/global-setup.mjs                                       — 新增、Playwright globalSetup。回傳 teardown 函式，所以就算某條測試炸掉、環境也不會活過整次執行
tests/e2e/playwright.config.mjs                                  — 新增、單一 worker、不平行：所有測試共用一個環境跟一個資料庫，而憑證接力那條會寫瀏覽器儲存空間、平行跑會互相看到。失敗才留截圖與 trace，而且寫到系統暫存目錄不進 repo（順帶避開一個誤判：commit 前檢查把 .gitignore 裡的 `tests/e2e/.artifacts/` 當成看起來像密鑰的長字串擋掉，這是那條長度啟發式的第四個誤判案例，尚未回報 — 回報需要 Vin 親手打確認語句）
tests/e2e/console.spec.mjs                                       — 新增、18 條。這些是 node --test 做不到的部分：它不能渲染 React，所以「一般成員只看得到自己的區塊」「憑證有交出去」以前都只是對原始碼字串的斷言，而原始碼看不出一個選單項目有沒有出現在畫面上
```
修改檔：
```
package.json                                                     — 加 devDependency @playwright/test 與 test:e2e 腳本。devDependency 不會進映像（Dockerfile 用 npm ci --production）
(不需要改 .gitignore：失敗截圖與 trace 直接寫到系統暫存目錄、不進 repo)
```

**選 navItem 用「看得見的文字」而不是 accessible name**，這件事本身抓到一個假綠燈：指路牌的小圓點帶 aria-label，所以那些項目的 accessible name 是「系統設定 這個功能還在舊後台」這種複合字串，用 `exact: true` 比對永遠回 0 — 於是所有 `toHaveCount(0)` 的負向斷言都會過，就算項目真的出現在一般成員的畫面上也一樣。

**踩坑紀錄那條原本也是假的**：全新資料庫三個區塊都是空的，頁面正確顯示「沒發現問題」，於是三個區塊根本沒渲染、等於什麼都沒驗。改成 harness 塞一筆六輪、沒有遵守紀錄的 session，讓三個區塊真的長出來、第三區真的有一列。

四項突變測試（把廣播管理開放給 admin、登出不清舊鍵、憑證寫入改成空操作、拿掉路由角色守門）全部被抓到，每一項都先重建前端才跑，因為瀏覽器載的是打包後的檔案不是原始碼。

## v1.26.46 修改（指路牌、舊後台功能清單、搬回 /me/ 缺的四塊 — 單一後台整併的階段 1a）

新增檔：
```
shared/legacy-console-manifest.js                                — 新增、舊後台功能清單，整併的結構性卡控。每個功能記 signpost（還在舊後台）或 live（已重建），三個讀者共用同一份：後台的路由決定畫真頁面還是指路牌、導覽列決定標哪些項目、伺服器決定要不要掛 /admin。最後一個 signpost 翻成 live 的那一刻，/admin 就自動停止服務並開始轉址，不需要再改任何地方。放 shared/ 是刻意的：複製一份到 client/ 就變成兩份要同步的東西，而那正是這份清單要取代的失效模式。載入時就驗證，且對未知狀態失敗關閉（拼錯的 state 會被當成「不是 signpost」，等於提早退役、把還在用的功能弄下線，所以直接 throw）
src/utils/relative-redirect.js                                   — 新增、算相對轉址目標。nginx 會把 /ownmind 前綴吃掉才轉給 Express，所以絕對路徑的 Location 在正式機會掉前綴。相對路徑由瀏覽器對「請求的目錄」解析，所以 ../ 要幾層取決於請求多深 — 算錯是無聲的，某個深度會通、另一個深度變 404。深度用 split('/').length - 2 算，不用 filter(Boolean)：後者會把連續斜線的空段一起丟掉、少算一層
src/middleware/legacy-admin-mount.js                             — 新增、/admin 的二選一。還有 signpost 就靜態服務舊後台，沒有了就 301 轉到新後台。兩個分支同時裝好、轉址先睡著，避免「最後一頁搬完」到「有人想起要寫轉址」之間 /admin 變 404。抽成函式是為了讓測試能跑兩個方向：app.js 在載入時就從模組常數決定，測試改不動
client/src/components/common/Signpost.jsx                        — 新增、指路牌，取代原本四個空殼頁的「此頁面正在重構中、即將於後續階段完工」。那句話不是實話：功能現在就在舊後台好好地跑著。標題跟導覽列共用同一個 i18n key、舊後台頁籤名稱來自功能清單，所以同一個功能不會在兩個地方叫兩個名字
client/src/api/legacy-handoff.js                                 — 新增、跨到舊後台前把憑證交過去。三個後台的鍵名不同（om_api_key / ownmind_api_key / ownmind.api_key）所以互不覆蓋，但值是同一個 users.api_key，寫進舊鍵名舊後台就會自己還原 session、不用再登入。同源的 localStorage 寫入、沒有任何東西離開瀏覽器。即使路由已經擋過角色，這裡仍再檢查一次：POST /api/admin/login 只收 admin 以上，把可用憑證交給一般成員等於把人送到進不去的門口
client/src/pages/Portal/NarrativePage.jsx                        — 新增、整體分析，從舊 /me/ 搬過來。機械段 GET /api/me/narrative 十個區塊必定拿得到，洞察段 GET /api/me/narrative/insights 是 LLM 產生的白話說明。兩支平行發、機械段先畫；洞察失敗只換掉說明文字不讓整頁空白（報告的價值在數字）。503 no_api_key（管理者沒設 LLM）跟其他錯誤分開講。沒有資料的成員單獨標示並在最上面說明排名不完整，不畫成 0
client/src/pages/Portal/PitfallsPage.jsx                         — 新增、踩坑紀錄，從舊 /me/ 搬過來。GET /api/me/pitfalls 三個區塊（伺服器沒留紀錄／AI 沒回報／整段對話沒紀錄）。刻意對所有人開放、跟舊頁一樣：這些是系統或 AI 行為問題不是個人隱私，而且只有橫著看才看得出模式。每列一定顯示「怎麼處理」，因為多半是「歷史殘留、不用動」，不講清楚每個人都會想去手動補資料
client/src/pages/Portal/AuditFindings.jsx                        — 新增、資料品質警示，第一次盤點漏掉的兩個功能之一。來源是 GET /api/me/report 的 me.audit_findings。這是「頁面上的數字可不可信」的唯一提示：collector 掛掉的人看到的用量會偏低而且看起來完全正常。訊息由伺服器組（含實際數量）照原文顯示。嚴重程度不只用顏色、另外標文字
client/src/api/legacy-keys.js                                    — 新增、舊後台四個 localStorage 鍵名，刻意無 import。legacy-handoff 寫它們、auth 登出時清它們，放在任一邊都會讓另一邊 import，而 legacy-handoff 已經 import auth、迴圈會穿過憑證程式碼
tests/legacy-console-manifest.test.js                            — 17 tests：清單形狀（狀態字彙、路徑與 id 唯一、退役由 signpost 數推導）、指路牌指向的頁籤真的存在於 src/public/index.html、沒有指路牌開放給進不了舊後台的角色、/admin 二選一的兩個方向都驗（有 signpost 要服務且不轉址、沒有要轉址且不服務，兩邊都要驗否則等於什麼都沒證明）、相對轉址各種深度與連續斜線、以及 app.js 不能繞過清單直接掛 /admin
tests/console-nav-structure.test.js                              — 19 tests：每個導覽項目都對到真頁面或指路牌（稽核記錄那個缺陷：選單指向一個哪裡都不存在的功能）、清單每一筆都有位子、每一項都有圖示、沒有兩項共用同一個 label key（週/月報被誤認成回報紀錄就是這樣來的）、三語系都有字、角色過濾（含未知角色看不到任何東西）、路由由導覽資料長出來、被拒角色的預設頁自己不能被角色擋（否則身分讀不到時會無限轉圈）
```
修改檔：
```
src/app.js                                                       — /admin 改走 installLegacyAdminMount，掛不掛由功能清單決定，不再無條件 express.static
src/public/index.html                                            — enterDashboard 結尾支援 #<tab> 深連結，讓指路牌直接把人帶到對應頁籤，否則每個指路牌都得寫成「進去之後自己找第幾個頁籤」。只認已顯示的按鈕（角色不夠時 hash 無效）、包 try/catch（hash 帶錯值最多回預設頁籤）
src/routes/me-narrative.js                                       — ranking 加 measured 欄位。LEFT JOIN 讓「這段期間沒有這個人的資料」跟「這個人什麼都沒做」都變成 0，而這份 payload 會餵給 LLM，它會很自信地寫成「某人幾乎不用 OwnMind」。空白欄位會讓人起疑、一個句子會讓人相信，所以文字比表格更需要這個區分
src/lib/llm-narrative.js                                         — 系統提示加第 9 條：measured=false 是「沒有資料」不是「用得少」，不要放進排名比較，ranking 的說明要先講排名不完整
client/vite.config.js                                            — 加 @shared alias（指到 ../shared）與 dev server fs.allow，讓後台能 import 共用的功能清單
Dockerfile                                                       — client-builder stage 加 COPY shared/ /shared/。WORKDIR 是 /client，alias 指到 /shared，沒複製進去 build 會直接失敗
client/src/App.jsx                                               — 路由改由導覽資料（allNavItems）長出來，所以不會出現「側邊欄有這一項但沒路由」或反過來。守門層級讀同一份 minRole。三種 renderer 收成 renderPage／renderGated 兩種。導覽項目兩邊都沒對到東西時顯示明白的接線錯誤，不再是「即將完工」那種騙人的空殼
client/src/components/common/nav-sections.js                      — 重組成 我的／團隊／偏好設定／管理／系統 五區，權限從「區塊」下降到「項目」。系統區同時有 系統設定（admin+，對應舊後台裝機狀況卡片）跟 廣播管理／工作紀錄（super_admin，對應 super-admin-only 標記與 superAdminAuth 路由），一個區塊只能挑一個角色的話必定犧牲其中一邊。移除 /super/audit（稽核記錄從來沒有頁面也沒有 API）。/super/* 改名 /system/*，因為那一區的角色是混的、叫 super 會誤導
client/src/components/common/Sidebar.jsx                         — 改用 visibleSections（區塊只要還有一項看得到就出現）。還在舊後台的項目標一個琥珀色小點、不要讓人以為已經搬完
client/src/components/common/Layout.jsx                          — 頁面標題改問導覽列（navLabelKey），移除自己維護的 PATH_TITLE_KEYS。原本註解就寫著「新頁面要在 NAV_SECTIONS 加路由、也要在這裡加標題對應」— 那就是第二個要記得改的地方，而且忘了改不會壞、只會靜靜顯示成「OwnMind 控制中心」
client/src/components/common/RequireRole.jsx                     — 拒絕時的目的地改讀 ROLE_DENIED_REDIRECT 常數，跟路由表同源
client/src/session/roles.js                                      — 新增 ROLE_DENIED_REDIRECT。目的地本身必須每個角色都進得去，否則身分查詢失敗的 session 會在預設頁之間無限轉圈；由測試拿導覽列的 minRole 驗
client/src/session/SessionContext.jsx                            — 身分多帶 id。舊後台從 om_user_id 還原 session，指路牌交憑證時需要
client/src/api/client.js                                         — export appBase()，讓 legacy-handoff 不用再寫一份一樣的前綴 regex
client/src/api/auth.js                                           — clearApiKey 一併清舊後台那四個鍵。指路牌會把一把真的可用的憑證寫進 om_api_key，只清自己那一份的話，登出之後下一個打開 /admin/ 的人會被還原成上一個人的身分
client/src/pages/Portal/UsagePage.jsx                            — 補自訂日期區間（伺服器早就支援 ?start=&end=、只有舊 /me/ 有介面）。effect 依賴算好的查詢字串，所以日期填一半不會打出半套請求。資料品質警示放在分頁標籤上面，因為它警告的是「下面的數字可能不完整」
client/src/components/common/index.js                            — barrel 加 export Signpost
client/src/i18n/{zh,en,ja}.json                                  — 新增五區塊名稱、七個新導覽項目、舊後台頁籤名稱、指路牌四句、整體分析與踩坑紀錄全部字串、資料品質警示、自訂區間。移除 nav.audit／nav.team／nav.section.{portal_analytics,personal,super}／placeholder.coming_soon 六個死鍵。nav.config 從「系統配置與計價」改成「系統設定」（計價依 Requirement 8 要移除）、nav.bugs／nav.members 對齊舊後台原本的頁籤名
package.json                                                     — 版號 1.26.45 → 1.26.46
README.md, docs/README.zh-TW.md, docs/README.ja.md               — 版號行 v1.26.45 → v1.26.46
tests/console-session-identity.test.js                           — 三條斷言改寫。原本比對手寫的 <Route> 與 renderAdmin／renderSuper 這兩個名字，並從「區塊」讀所需角色；路由現在由導覽資料長出來、角色改成逐項，那些斷言只能靠維持它們描述的形狀才留得住。它們保護的東西現在更強：一致性變成結構上就成立（同一個 minRole 同時餵側邊欄跟守門員），一致性、過濾、預設頁迴圈都在 console-nav-structure.test.js 真的執行
```

## v1.26.45 修改（後台角色控管 — 單一後台整併的階段 0）

新增檔：
```
client/src/session/SessionContext.jsx                            — 新增、登入後從 GET /api/me/profile 取真實身分（角色、姓名），由 SessionProvider 持有並提供 useSession()。角色刻意不寫進 localStorage（舊後台用 om_role 存、使用者改得動就看得到管理卡片），只放記憶體、每次載入重問伺服器。另提供 logout()：清憑證後發 auth-expired 事件，跟 token 失效走同一條回 /login 的路
client/src/session/roles.js                                      — 新增、角色階梯與路由守門判斷純邏輯（roleAtLeast / decideRoleGate），刻意不含 JSX 所以 node --test 進得去。ROLE_RANK 用 Object.create(null)：物件實字會讓 ROLE_RANK['valueOf'] 是函式而非 undefined，實測 roleAtLeast('valueOf','valueOf') 回 true、失敗開放。decideRoleGate 先判就緒再判角色，這個順序讀原始碼驗不出來、必須執行
client/src/components/common/RequireRole.jsx                     — 新增、角色路由守門員。RequireAuth 管「有沒有登入」、這支管「准不准進來」。先等身分確定才判斷，否則直接開網址時管理員會在身分還在路上時被踢走
client/src/api/events.js                                         — 新增、跨層事件名稱常數（SESSION_CHANGED / AUTH_EXPIRED）。原本 session-changed 在 auth.js 跟 SessionContext 各寫一份、auth-expired 有三份，而測試只檢查「有 dispatchEvent」「有 addEventListener」，任一邊打錯一個字就會靜靜停止刷新而測試全綠
client/src/components/common/nav-sections.js                     — 新增、導覽結構純資料（無 import、無 JSX），這樣「誰看得到哪一區」才能被真的跑起來的測試拿去跟路由守門層級比對。原本埋在 Sidebar.jsx 裡，唯一測得到的只有「檔案含 roles: [ 這個字串」，開放給錯的角色照樣會過。圖示改由 path 對照留在 Sidebar
tests/console-session-identity.test.js                           — 34 tests：身分不是常數、角色不落地儲存、Layout 自己讀 session、守門員先等身分再導向、管理／超級管理路由各走對應的 renderAdmin／renderSuper、憑證變更會廣播、角色模擬器已移除且三語系無死鍵、選單指向既有路由。其中 14 條真的執行程式：角色階梯（含原型鍵的失敗關閉）、路由守門的三種判斷（等待／拒絕／放行，含「未就緒絕不拒絕」這條抓重排的斷言）、事件名稱兩邊相等、三語系字典鍵完全平行
```
修改檔：
```
client/src/App.jsx                                               — 移除寫死的 useState('super_admin')、姓名 'User'、console.log 登出、沒實作的 onOpenProfile。改成 renderPage／renderAdmin／renderSuper 三種 renderer，後兩者多包 RequireRole
client/src/components/common/Layout.jsx                          — 角色與姓名改成自己從 useSession 讀，不再由 App 往下傳（同 v1.26.43 版號的理由：Layout 只在登入後渲染）
client/src/pages/LoginPage.jsx                                   — 登入成功後把回應裡的身分直接餵進 session。navigate 跟 setApiKey 是同一個同步區塊，不餵的話目的頁會拿到「已解析但沒有角色」的身分，管理員從深連結登入每次都被導去用量頁
client/src/components/common/Sidebar.jsx                         — 導覽結構移出到 nav-sections.js，本檔只留 path 到圖示的對照
client/src/api/client.js                                         — auth-expired 改用共用常數
client/src/components/common/TopBar.jsx                          — 移除角色模擬器；選單「個人資料」「偏好設定」兩項收成一項並改用 <Link> 連到 /preference/profile
client/src/components/common/index.js                            — barrel 加 export RequireRole
client/src/api/auth.js                                           — setApiKey / clearApiKey 發出 ownmind:session-changed，讓身分自動重載，不靠呼叫端記得 refresh
client/src/main.jsx                                              — 在 BrowserRouter 外層包 SessionProvider
client/src/i18n/{zh,en,ja}.json                                  — 移除 header.role_simulator 與 menu.preferences 兩個死鍵；新增 session.identity_unavailable（身分取得失敗時明講，不要靜靜降級成空側邊欄加「訪客」）
README.md, docs/README.zh-TW.md, docs/README.ja.md               — 版號行 v1.26.44 → v1.26.45（三份都漏過，沒有任何卡控）
tests/dashboard-version-source.test.js                           — 放寬「每個 Layout 都在 RequireAuth 底下」的斷言，允許中間插入其他守門層。原本三層緊貼比對，插入 RequireRole 就失敗，但不變式沒被破壞
```

## 單一後台整併規劃（跨版本專案，階段 0 與 1a 已完成）

新增檔：
```
openspec/changes/archive/single-console-consolidation/proposal.md  — 把 /admin/、/me/、/dashboard/ 三個後台收成一個的提案。含現況盤點、四個改變估算的發現（廣播藏在設定分頁裡、稽核記錄是從沒做出來的功能、/me/ 有兩個功能新後台沒覆蓋、新後台完全沒有角色控管）、五個選項的評估與否決理由、以及對抗審查回合的完整紀錄（3 Critical 3 Important，兩條採納、三條實測駁回、一條結論對理由錯）
openspec/changes/archive/single-console-consolidation/spec.md      — 規格（GIVEN/WHEN/THEN，6 條 requirement）：單一入口、角色控管、不掉功能、轉址要能撐過反向代理前綴、退場靠結構而非提醒、舊檔留存但不可被服務
openspec/changes/archive/single-console-consolidation/tasks.md     — 七階段任務清單（Stage 0 真實身分 / 1a 搬頁面與指路牌 / 1b 換入口與收 /me/ / 2 使用者管理 / 3 設定與廣播 / 4 錯誤回報與工作紀錄 / 5 退場後清理）
```

## v1.26.44 修改（新後台直接開網址全白 — SPA 深連結的 base href）

新增檔：
```
openspec/changes/archive/v1.26.44-spa-deep-link-base/proposal.md         — v1.26.44 提案（含四個選項的評估與否決理由）
openspec/changes/archive/v1.26.44-spa-deep-link-base/spec.md             — v1.26.44 規格（GIVEN/WHEN/THEN）
openspec/changes/archive/v1.26.44-spa-deep-link-base/tasks.md            — v1.26.44 任務清單（含已知限制與「列了沒修」）
src/utils/spa-shell.js                                           — 新增、供應 SPA 外殼時依請求深度改寫 <base href>（relativeBaseHref / withBaseHref / createSpaShellHandler）。送出的值保持純相對，所以 nginx 的 /ownmind 前綴不需要也不假設
tests/spa-deep-link-base.test.js                                 — 33 tests（有 build 時 33 綠 0 跳過；無 build 時 node 只跑到 26 條、21 綠 5 跳過）：fixture 外殼的各深度 base href、資產照瀏覽器方式解析後真的 fetch 到 200、證明修正前確實 404 的反向測試、前綴不綁死、withBaseHref 找不到 base 會插入而非空轉、既有行為（資產 miss 仍 404 / 非 GET 不吃外殼 / 外殼不存在時 fall through 不 500）、drift 守門
```
修改檔：
```
src/app.js                 — /dashboard 的 SPA fallback 從裸 res.sendFile 換成 createSpaShellHandler
package.json / package-lock.json — 版號 1.26.43 → 1.26.44
README.md / docs/README.zh-TW.md / docs/README.ja.md — 版本行 → v1.26.44
CHANGELOG.md               — v1.26.44 條目
FILELIST.md                — 本段
```
**未動**：`client/vite.config.js` 的 `base: './'` 跟 `client/index.html` 的 `<base href="./">`（那是掛載點根目錄需要的正確預設值、也讓外殼直接開啟時仍可用）；路由、資產 404 行為、舊的 `/admin` 與 `/me` 介面

**版號說明**：這件工作原本標 v1.26.42、但 v1.26.43 先發布了，所以改編為 1.26.44。

## v1.26.43 修改（新後台版號改跟 server 拿、SERVER_VERSION 收成一處）

新增檔：
```
openspec/changes/archive/v1.26.43-dashboard-version-source/proposal.md  — v1.26.43 提案（含「為什麼是連線拿不是編譯時寫死」的取捨）
openspec/changes/archive/v1.26.43-dashboard-version-source/spec.md      — v1.26.43 規格（GIVEN/WHEN/THEN，4 條 requirement）
openspec/changes/archive/v1.26.43-dashboard-version-source/tasks.md     — v1.26.43 任務清單
src/utils/server-version.js                                     — 新增、SERVER_VERSION 的唯一定義（讀不到 package.json 回 0.0.0、不丟例外）
src/routes/version.js                                           — 新增、GET /api/version 只回 { version }，factory 形式（比照 createDebugRouter）掛在 auth 後面
client/src/hooks/useServerVersion.js                             — 新增、走 apiGet('/api/version')，初值空字串、失敗維持空字串。模組層級快取（只快取成功值）。**只能從 Layout 呼叫**：從 App 呼叫會在還沒登入時吃 401 且永不重試
tests/dashboard-version-source.test.js                           — 20 tests：共用模組對得上 package.json、manifest 壞掉退 0.0.0、src/ 底下沒有本地 SERVER_VERSION 定義、使用者都 import 共用模組、端點回傳與 auth 卡控、client/src 沒有版號字面值、hook 只能從 Layout 呼叫且每個 Layout 都在 RequireAuth 裡、LoginPage 不渲染 Layout、hook 走 apiGet 不用裸 fetch、失敗不進快取、Footer 空狀態與三語系字串。去註解工具改成會辨識字串（原本會被 glob 裡的 /* 騙）
```
修改檔：
```
src/routes/memory.js                — 移除本地 SERVER_VERSION IIFE 與 createRequire import，改 import 共用模組
src/jobs/nightly-upgrade-reminder.js — 同上
src/routes/usage/admin-clients.js    — 同上
src/app.js                           — 掛載 /api/version
client/src/App.jsx                   — 拿掉寫死的 version: 'v1.20.1' 與 MOCK_CHANGELOG，changelog 傳 []，不再往下傳 version
client/src/components/common/Layout.jsx — 改由這裡呼叫 useServerVersion（只在 RequireAuth 底下渲染、請求一定帶金鑰），props 移除 version
package.json / package-lock.json     — 版號 1.26.41 → 1.26.43
README.md / docs/README.zh-TW.md / docs/README.ja.md — 版本行 → v1.26.43
CHANGELOG.md                         — v1.26.43 條目
FILELIST.md                          — 本段
```
**未動**（Vin 拍板只修版號、其餘另開）：`client/src/App.jsx` 同一塊 layoutProps 的 `profile: { name: 'User' }`、`onLogout` 的 console.log、角色寫死 `super_admin`

**版號跳號說明**：`v1.26.42` 由另一個同時進行的 session 佔用（SPA 子路徑直接開會空白那件），所以本次取 1.26.43。

## v1.26.41 修改（相依套件安全警告 + root 相依版本門檻）

新增檔：
```
openspec/changes/archive/v1.26.41-dependency-security/proposal.md        — v1.26.41 提案（37 個警告的分類、PR #45 驗證、送不到使用者機器的根因）
openspec/changes/archive/v1.26.41-dependency-security/spec.md            — v1.26.41 規格（GIVEN/WHEN/THEN，6 條 requirement）
openspec/changes/archive/v1.26.41-dependency-security/tasks.md           — v1.26.41 任務清單（含「沒驗到的部分」獨立一段）
scripts/install-helpers/dep-floor.mjs                            — 新增、root 相依版本門檻比對純函式庫（parseVersion / satisfiesFloor / readInstalledVersion，import 不觸發任何副作用）
scripts/install-helpers/dep-floor-cli.mjs                        — 新增、給 shell 用的判斷式（exit 0 = 已達門檻、exit 1 = 要裝）。刻意獨立成檔、不做「我是不是被直接執行」判斷（那種判斷遇到 symlink 路徑會靜默跳過並 exit 0、被讀成「已達門檻」）
tests/dep-floor-guard.test.js                                    — 27 tests：版本比對（數值/prerelease/壞輸入 fail safe）、CLI 契約（exit code、stdout 靜默、缺參數、symlink 路徑）、把 update.sh 的 needs_root_dep 真實函式抽出來實跑、六個漂移守門（CLI 有接線且沒直接 import 函式庫、資料夾檢查沒復活、判斷極性沒被反轉、log 目錄有先建、腳本門檻 ≥ manifest、安裝範圍 ≥ 門檻）
```
修改檔：
```
scripts/update.sh          — 資料夾存在檢查改成 needs_root_dep()（呼叫 dep-floor-cli.mjs）；js-yaml 門檻 4.3.0、node-machine-id 門檻 1.1.12；新增 mkdir -p ~/.ownmind/logs（redirect 失敗會讓判斷式每次同步都回報要裝，且既有 npm install 的 redirect 從 v1.18.5 就依賴這個目錄）；node stderr 導進 update-err.log 而非 /dev/null
scripts/update.ps1         — 同上、改用 Test-RootDepNeeded()；用 *> $null 而非 2> $null（避免 stdout 汙染函式回傳值）；先明確檢查 helper 與 node 是否存在（StrictMode 下 $LASTEXITCODE 在第一個原生指令前不存在、node 不在時 & node 拋錯也不會設它）；改動區塊的中文註解翻成英文
package.json               — 版號 1.26.40 → 1.26.41；js-yaml ^4.1.1 → ^4.3.0
package-lock.json          — js-yaml 4.1.1 → 4.3.0（CVE-2026-59869）、body-parser 2.2.2 → 2.3.0
client/package-lock.json   — react-router-dom / react-router 7.15.1 → 7.18.2（CVE-2026-53669 等 4 條）
mcp/package-lock.json      — @modelcontextprotocol/sdk 1.28.0 → 1.30.0、@hono/node-server 1.19.14 → 2.0.12
README.md / docs/README.zh-TW.md / docs/README.ja.md — 版本行 v1.26.36 → v1.26.41（v1.26.37~40 漏更新、三語系一起補）
CHANGELOG.md               — v1.26.41 條目
FILELIST.md                — 本段
```
**未動**：`client/vite.config.js` 的 `sourcemap: true`（production build 會帶 3.2 MB 的 .map 進 image、已列 backlog）；`.github/workflows/`（這個 repo 沒有 CI、是 PR #45 掛一天沒人驗的原因、但要另案決定）

**由 PR #45（`cc213fd`）帶進來**：`mcp/package-lock.json`（body-parser / fast-uri / hono / ip-address / qs）、`client/package.json` + `client/package-lock.json`（vite 8.0.14 → 8.1.5、postcss 8.5.15 → 8.5.24）

## v1.26.40 修改（Bug #8：密碼偵測誤判普通英文句子）

新增檔：
```
openspec/changes/archive/v1.26.40-wp-password-prose/proposal.md         — v1.26.40 提案（含四個候選規則的量測數據）
openspec/changes/archive/v1.26.40-wp-password-prose/spec.md             — v1.26.40 規格（GIVEN/WHEN/THEN，4 條 requirement）
openspec/changes/archive/v1.26.40-wp-password-prose/tasks.md            — v1.26.40 任務清單
tests/secret-detect-wp-prose.test.js                            — 22 tests：真密碼召回（含 2000 組固定種子產生）、已知殘留漏抓釘住、五種散文放行、前綴 1~7 詞的重疊視窗、其餘規則不受影響
```
修改檔：
```
shared/secret-detect.js    — 新增 looksLikePlainWord() 與 findConfirmedMatch()（重疊掃描）；WP 密碼規則加 confirm 組成檢查；regex 迴圈改掃所有命中
package.json               — 版號 1.26.39 → 1.26.40
CHANGELOG.md               — v1.26.40 條目
FILELIST.md                — 本段
```

## v1.26.39 修改（後台「記憶總數」永遠顯示 0）

新增檔：
```
openspec/changes/archive/v1.26.39-admin-memory-count/proposal.md        — v1.26.39 提案
openspec/changes/archive/v1.26.39-admin-memory-count/spec.md            — v1.26.39 規格（GIVEN/WHEN/THEN，5 條 requirement）
openspec/changes/archive/v1.26.39-admin-memory-count/tasks.md           — v1.26.39 任務清單
tests/admin-stats-memory-count.test.js                          — 12 tests：把 countExportedMemories 從 HTML 抽出來實跑（現行/退路格式、壞資料、0 值、非有限數、接線釘死元素、res.ok、標籤）
```
修改檔：
```
src/public/index.html      — 新增 countExportedMemories()；loadStats() 改用它並加 res.ok 檢查；卡片標籤 記憶總數 → 我的記憶（啟用中）
package.json               — 版號 1.26.38 → 1.26.39
CHANGELOG.md               — v1.26.39 條目
FILELIST.md                — 本段
```

## v1.26.38 修改（團隊規範細節終於真的共用）

新增檔：
```
openspec/changes/archive/v1.26.38-share-standard-details/proposal.md   — v1.26.38 提案
openspec/changes/archive/v1.26.38-share-standard-details/spec.md       — v1.26.38 規格（GIVEN/WHEN/THEN，7 條 requirement）
openspec/changes/archive/v1.26.38-share-standard-details/tasks.md      — v1.26.38 任務清單
src/utils/memory-visibility.js                                 — 共用讀取述詞：SHARED_MEMORY_TYPES / isSharedMemoryType / buildReadableWhere
tests/memory-visibility.test.js                                — 34 tests：共用型別 / 述詞結構 / 參數綁定位置 / 路由接線 / 共用型別寫入需 admin / 寫入未放寬 / MCP 兩端
```
修改檔：
```
src/routes/memory.js       — /type/:type（加選填 parent_id）、/search、/:id（加狀態過濾）改用 buildReadableWhere；POST / + PUT /:id + disable 的 admin 卡控從 team_standard 擴到所有共用型別
mcp/index.js               — ownmind_get enum 補 standard_detail + 選填 parent_id 參數；TYPE_MAP 補對應標籤（ownmind_save enum 刻意不加）
README.md                  — 團隊標準推播段落改為「摘要強制載入、細節按需調閱」
docs/README.zh-TW.md       — 同上（中文）
docs/README.ja.md          — 同上（日文）
package.json               — 版號 1.26.37 → 1.26.38
CHANGELOG.md               — v1.26.38 條目
FILELIST.md                — 本段
```

## v1.26.37 修改（Bug #7 修：關鍵字搜尋改進 + 下架 semantic 口號）

新增檔：
```
openspec/changes/archive/v1.26.37-improve-keyword-search/proposal.md   — v1.26.37 提案
openspec/changes/archive/v1.26.37-improve-keyword-search/tasks.md      — v1.26.37 任務清單
shared/memory-search-tokens.js                                 — 共用：tokenize + itemMatchesTokens（online 跟 offline 都用同一份）
src/utils/memory-search-query.js                               — SQL builder：buildSearchWhere + LIKE metacharacter escape
tests/memory-search-query.test.js                              — 15 tests：tokenize / builder / LIKE escape / route wiring
```
修改檔：
```
src/routes/memory.js       — /search 改用 buildSearchWhere；tip + SOP 移除 "semantic" 字樣
mcp/index.js               — session-start tip 改為描述關鍵字搜尋；offline notice 拿掉「semantic」
mcp/offline.js             — localSearch 改用共用 tokenize + itemMatchesTokens（offline 跟 online 語意對齊）
tests/offline.test.js      — 加 4 個 tests：tag/code/multi-token/空查詢覆蓋新 localSearch 行為
README.md                  — 語意搜尋 bullet 改為「關鍵字搜尋」+ 註明 pgvector 是預留
docs/README.zh-TW.md       — 同上（中文）
docs/README.ja.md          — 同上（日文）
package.json               — version 1.26.36 → 1.26.37
CHANGELOG.md               — v1.26.37 條目
FILELIST.md                — 本檔
```

## v1.26.36 修改（程式碼註解人名去識別化 + 名字守門）

新增檔：
```
openspec/changes/archive/v1.26.36-deidentify-name-comments/proposal.md  — v1.26.36 提案
openspec/changes/archive/v1.26.36-deidentify-name-comments/tasks.md     — v1.26.36 任務清單
```
修改檔（12 處註解去名，11 檔）：
```
src/utils/iron-rule-origin-context.js / run-migrations.js / iron-rule-suggest.js
src/routes/me.js
mcp/lib/compose-tool-response.js
hooks/ownmind-tty-echo.cjs / ownmind-reply-lint.js / ownmind-session-start.sh
hooks/lib/conditional-sync.js / flush-compliance-spool.js
shared/language-lint.js
package.json                              — version 1.26.35 → 1.26.36
tests/no-hardcoded-names-in-output.test.js — 新增程式碼檔名字 source-scan 守門
```

## v1.26.35 修改（使用者可見產出去識別化：拿掉人名 Vin）

新增檔：
```
openspec/changes/archive/v1.26.35-deidentify-names-in-output/proposal.md  — v1.26.35 提案
openspec/changes/archive/v1.26.35-deidentify-names-in-output/tasks.md     — v1.26.35 任務清單
tests/no-hardcoded-names-in-output.test.js                        — 守門：產生器輸出禁人名
```
修改檔：
```
src/utils/iron-rule-sync.js     — SKILL.md 產生器「Vin」→ 泛用第二人稱（3 處）
src/utils/iron-rule-suggest.js  — 建議說明「是 Vin...」→「是你...」
src/lib/llm-narrative.js        — prompt 範例名 Vin → Alice
client/src/App.jsx              — 預設 profile name 'Vin' → 'User'
package.json                    — version 1.26.34 → 1.26.35
tests/iron-rule-sync.test.js    — 斷言配合新文字更新
```

## v1.26.34 修改（產品碼個人鐵律編號大掃除 + 守門測試）

新增檔：
```
openspec/changes/archive/v1.26.34-guard-personal-codes/proposal.md  — v1.26.34 提案
openspec/changes/archive/v1.26.34-guard-personal-codes/tasks.md     — v1.26.34 任務清單
tests/no-personal-rule-codes.test.js                        — 守門測試（產品碼禁個人編號）
```
修改檔（去識別化，28 檔，多為註解/字串）：
```
hooks/lib/select-block-fingerprint.js  — 移除個人編號品管分類（功能性）
hooks/ownmind-git-commit-msg           — 標籤中性化 +「Vin 的鐵律」→「你的鐵律」
hooks/ownmind-reply-lint.js / bypass-handler.js / iron-rule-check.js / session-start.sh / secret-guard-rule.js / rule-enforcer.js
src/routes/memory.js / secret.js / debug.js / me.js / activity.js
src/utils/iron-rule-quality.js / iron-rule-suggest.js / iron-rule-sync.js / auto-numbering.js
mcp/index.js / start.cmd / ownmind-log.js
shared/lint-event-types.js / privacy-detect.js / iron-rule-tier.js / compliance.js
client/src/pages/Preference/VaultPage.jsx / Portal/HandoffsPage.jsx / components/common/RequireFreshPassword.jsx
src/public/index.html / me/index.html
package.json                           — version 1.26.33 → 1.26.34
tests/git-pre-commit-fingerprint.test.js / git-hook-co-authored-by.test.js — 配合去識別化更新斷言
```

## v1.26.33 修改（pre-commit 密鑰防護去識別化）

新增檔：
```
openspec/changes/archive/v1.26.33-deidentify-secret-guard-hook/proposal.md  — v1.26.33 提案
openspec/changes/archive/v1.26.33-deidentify-secret-guard-hook/tasks.md     — v1.26.33 任務清單
hooks/lib/secret-guard-rule.js                                      — isSecretGuardRule 純函式（語意判斷密鑰防護規則）
tests/secret-guard-rule.test.js                                    — 純函式單元測試
```
修改檔：
```
hooks/ownmind-git-pre-commit.js       — 內容掃描改綁 isSecretGuardRule、不再看 IR-002；blockReasons 帶 isSecretRule
hooks/lib/select-block-fingerprint.js — 密鑰類改用 isSecretRule/secretHit、拿掉 SECRET_RULE_CODES
package.json                          — version 1.26.32 → 1.26.33
tests/git-pre-commit-fingerprint.test.js — secret case 改用語意旗標 + 非 IR-002 案例
tests/pre-commit-secret.test.js       — 新增非 IR-002 規則 + 內容密鑰整合 reproduction
```

## v1.26.32 修改（鐵律合規觀測去識別化）

新增檔：
```
openspec/changes/archive/v1.26.32-deidentify-compliance-observability/proposal.md  — v1.26.32 提案
openspec/changes/archive/v1.26.32-deidentify-compliance-observability/tasks.md     — v1.26.32 任務清單
tests/deidentify-compliance-observability.test.js                          — 去識別化 reproduction test（6 case）
```
修改檔：
```
shared/lint-event-types.js   — 新增中性事件常數 RULE_FULL_LAYER_SYNC + 顯示名 + ALL_LINT_EVENTS
src/routes/activity.js       — autoEmitObservedTrigger 去識別化（3 分支）+ export + INSERT 寫 triggered_by_event
src/routes/memory.js         — v1.17.87 backfill 發射端去識別化（存 + 停用兩處）
mcp/index.js                 — autoComplyForToolCall 去識別化（2 處）+ dedup/logEvent/appendCompliance 改用 triggered_by_event
src/routes/me.js             — expected_rules 改中性事件（3 查詢）+ complianceGapQ/unverifiedQ 比對述句改事件式 + IR-006 legacy shim
package.json                 — version 1.26.31 → 1.26.32
tests/me-pitfalls.test.js    — 更新 compliance-log 斷言（IR-006 → 中性事件）
```

## v1.26.31 修改（bug 回報路由錯誤訊息英文化）

新增檔：
```
openspec/changes/v1.26.31-bug-reports-error-strings-en/proposal.md  — v1.26.31 提案
openspec/changes/v1.26.31-bug-reports-error-strings-en/tasks.md     — v1.26.31 任務清單
```
修改檔：`src/routes/bug-reports.js`（7 個中文權限錯誤字串英文化：`Admin permission required` ×5、`Insufficient permissions` ×2）。

## v1.26.30 修改（bug 回報 status_reason 枚舉驗證）

新增檔：
```
openspec/changes/v1.26.30-bug-report-status-reason-validation/proposal.md  — v1.26.30 提案
openspec/changes/v1.26.30-bug-report-status-reason-validation/tasks.md     — v1.26.30 任務清單
tests/bug-report-status-reason.test.js                                     — source-level 測試（含 DB 漂移比對）
```
修改檔：`src/routes/bug-reports.js`（新增 `ALLOWED_STATUS_REASONS` 常數 + PATCH `/:id/status` 枚舉守門，送錯值回 400 而非 500）。

## v1.26.29 修改（開放透過 ownmind_update 修改記憶標題）

新增檔：
```
openspec/changes/v1.26.29-memory-title-edit/proposal.md  — v1.26.29 提案
openspec/changes/v1.26.29-memory-title-edit/tasks.md     — v1.26.29 任務清單
tests/memory-title-update.test.js                        — 8 條 source-level 測試
```
修改檔：`mcp/index.js`（`ownmind_update` schema 加選填 `title` + handler 轉發）、`src/routes/memory.js`（PUT 空/非字串標題 400、trim 正規化、禁改名成 `__upgrade_test__` 前綴、掃密門涵蓋標題變更、history 記 `title_change`）。
歸檔：`openspec/changes/` 下 9 個已完成 change（v1.26.15～28）移入 `archive/`。

## v1.26.28 修改（密鑰掃描分隔線誤判 + 擋下訊息可行動化）

新增檔：
```
openspec/changes/v1.26.28-secret-scan-separator-lines/proposal.md  — v1.26.28 提案
openspec/changes/v1.26.28-secret-scan-separator-lines/tasks.md     — v1.26.28 任務清單
```
修改檔：`shared/secret-detect.js`（length heuristic 加 `PUNCTUATION_ONLY_REGEX` 排除純標點分隔線）、`hooks/ownmind-git-pre-commit.js`（擋下訊息附 `matched="…"` 命中片段；`regex:*` 命中遮罩頭8…尾4、`heuristic:*` 保留全文）、`tests/secret-detect-unit.test.js`（+8 條）、`tests/pre-commit-secret.test.js`（+3 條）。

## v1.26.27 修改（MCP client 必填參數前置防呆）

新增檔：`mcp/lib/required-args.js`（依工具 inputSchema.required 在連線前檢查缺漏必填參數、丟出可自我診斷的錯誤；鏡像伺服器 require-fields 判定，含 name→key 別名與 report_bug confirm_string 豁免）、`tests/required-args.test.js`（20 條測試）。
修改檔：`mcp/index.js`（`handleTool` 進 switch 前接上必填參數 guard）。

## v1.26.26 修改（MCP client 觀測性修正 — 必填欄位缺少診斷細節）

修改檔：`mcp/lib/api-error-message.js`（補渲染伺服器回傳的 `missing` / `received`，空 body 時白話提示可能是 MCP 程式卡住）、`tests/api-error-message.test.js`（+2 重現測試）。

## v1.26.25 修改（去識別化補漏 — Gemini 雙審查）

修改檔：`tests/upgrade-complete-beacon.test.js`（fixture adam-laptop→bob-laptop）、`.github/CODEOWNERS`（中文註解英文化、維護者帳號保留）。

## v1.26.24 修改（新增 .mcp.local.json 範本）

新增檔：`.mcp.local.json.example`（自架者複製成 gitignore 的 `.mcp.local.json` 填真值的參考範本）。
修改檔：`.mcp.json`（args 路徑改通用 `${HOME}/.ownmind/mcp/index.js`、`_comment` 指向範本）。

## v1.26.23 修改（主機網址設定化 + 去品牌化收尾）

新增檔：
```
openspec/changes/v1.26.23-host-config-extraction/proposal.md  — v1.26.23 提案
openspec/changes/v1.26.23-host-config-extraction/tasks.md     — v1.26.23 任務清單
```

改名：`docs/superpowers/specs/2026-05-29-host-config-extraction-design.md`（原檔名含主機名，已改為中性）。

修改檔（功能性）：`src/lib/llm-narrative.js`（讀 `OWNMIND_LLM_API_BASE`）、`tests/llm-narrative.test.js`、`hooks/ownmind-iron-rule-check.sh`、`scripts/health-report-daily.sh`、`client/src/scripts/translate.mjs`、`src/public/setup.html`、`src/public/me/index.html`、`.mcp.json`、`shared/language-lint.js`（白名單）+ `tests/language-lint-v1193.test.js`、`.env.example`、README ×3、`scripts/bootstrap.*`、`skills/ownmind-upgrade.md`。
修改檔（去品牌化）：CHANGELOG / FILELIST / docs / openspec 多檔的主機、公司網域、工作信箱、專案代號泛稱化；偵測器測試 email fixture 改 `acme.com`。

## v1.26.22 修改（開源前全倉貢獻者去識別化）

新增檔：
```
openspec/changes/v1.26.22-deidentify-contributors/proposal.md  — v1.26.22 提案
openspec/changes/v1.26.22-deidentify-contributors/tasks.md     — v1.26.22 任務清單
```

修改檔：約 49 個檔的真實貢獻者姓名改為一致代稱、內部專案代號中性化（tests/、src/、shared/、hooks/、scripts/、docs/、CHANGELOG.md、FILELIST.md）；另把 3 處先前記錄對照表的文件改寫成不揭露真名↔代稱。測試 fixture 輸入與斷言同步改名、行為不變。

## v1.26.21 修改（i18n 軌道 B：openspec 文件英文化 + 敏感資料清理）

新增檔：
```
openspec/changes/v1.26.21-i18n-openspec-docs/proposal.md            — v1.26.21 提案
openspec/changes/v1.26.21-i18n-openspec-docs/tasks.md               — v1.26.21 任務清單
docs/superpowers/specs/2026-05-29-host-config-extraction-design.md — 主機網址設定化重構設計稿（下一版用）
```

修改檔：
- `openspec/CONVENTIONS.md`（整檔英文化）+ `openspec/changes/archive/` 89 個封存提案（只翻說明散文、保留引用資料）。
- 敏感資料清理：真實姓名化名、本機路徑／範例信箱中性化、內部生態系名稱泛稱化（散在 archive 多檔）。
- 遠端存取事故樣本中性化：`tests/memory-secret-guard.test.js`、`tests/secret-detect-unit.test.js`、`shared/secret-detect.js`（行為不變）+ `CHANGELOG.md`、`FILELIST.md` 同步。

## v1.26.20 修改（清掉一處程式碼註解殘留的個人鐵律編號）

修改檔（純註解、零行為影響）：`src/utils/iron-rule-quality.js`（標題長度檢查註解，個人鐵律編號改成通用敘述）。

## v1.26.19 修改（i18n 軌道 B：tests/ 註解與測試描述英文化）

新增檔：
```
openspec/changes/v1.26.19-i18n-tests/proposal.md   — v1.26.19 提案
openspec/changes/v1.26.19-i18n-tests/tasks.md      — v1.26.19 任務清單
```

修改檔（只翻 `//`/`/* */`/JSDoc 註解 + describe/it/test 測試標籤；斷言值／fixture／測試資料保留中文）：47 支 `tests/` 測試檔（如 `tests/aggregation.test.js`、`tests/broadcast.test.js`、`tests/scanner-*.test.js`、`tests/iron-rule-tier-*.test.js`、`tests/validators/registry.test.js`、`tests/utils/md-parser.test.js` 等）。

## v1.26.18 修改（i18n 軌道 B：src/ 其餘檔案內部英文化）

新增檔：
```
openspec/changes/v1.26.18-i18n-src-rest/proposal.md   — v1.26.18 提案
openspec/changes/v1.26.18-i18n-src-rest/tasks.md      — v1.26.18 任務清單
```

修改檔（中文註解 + 內部訊息翻英文；user-facing 字串保留）：約 30 支 src/ 檔，含 `src/app.js`、`src/index.js`、`src/middleware/{auth,adminAuth,first-run-redirect}.js`、`src/lib/{broadcast-filter,session-query,memory-sync}.js`、`src/jobs/{weeklyReport,nightly-recompute,nightly-upgrade-reminder,seed-default-passwords,usage-aggregation}.js`、`src/services/bug-report-spam-detector.js`、`src/utils/{semver,syncToken,run-migrations,report,pricing-lookup,enrich-activity,activity-insert,auto-numbering,crypto,db,md-parser,require-fields,memory-secret-guard,memory-error-classifier,templates,bug-report-helpers}.js`、`src/constants.js`。

## v1.26.17 修改（修 sync_token 過時時自動重試失效）

新增檔：
```
openspec/changes/v1.26.17-sync-token-stale-retry/proposal.md   — v1.26.17 提案
openspec/changes/v1.26.17-sync-token-stale-retry/tasks.md      — v1.26.17 任務清單
```

## v1.26.16 修改（修 MCP client 吞掉 API 結構化錯誤細節）

新增檔：
```
mcp/lib/api-error-message.js                              — buildApiErrorMessage（組 error + errors + hint，修錯誤細節被吞）
tests/api-error-message.test.js                           — 6 case reproduction test
openspec/changes/v1.26.16-mcp-error-detail/proposal.md    — v1.26.16 提案
openspec/changes/v1.26.16-mcp-error-detail/tasks.md       — v1.26.16 任務清單
```

## v1.26.15 修改（i18n 軌道 B：src/ 鐵律家族工具內部英文化）

新增檔：
```
openspec/changes/v1.26.15-i18n-src-iron-rules/proposal.md   — v1.26.15 提案
openspec/changes/v1.26.15-i18n-src-iron-rules/tasks.md      — v1.26.15 任務清單
```

## v1.26.11 修改（國際化第十期 Part 4：tests/ 接續 30 檔英文化 — 軌道 B）

新增檔：
```
openspec/changes/archive/v1.26.11-i18n-tests-internal-part4/proposal.md      — v1.26.11 提案
openspec/changes/archive/v1.26.11-i18n-tests-internal-part4/tasks.md         — v1.26.11 任務清單
```

修改檔（30 個 tests/*.test.js + 版號 + 三語文件）：
```
tests/tier2-windows-fix.test.js                    — 31 行（Tier 2 Windows 安裝 + sqlite3 自動裝）
tests/iron-rule-frontmatter.test.js                — 31 行（detectFrontmatter YAML 解析 + 安全模式）
tests/update-script-observability.test.js          — 30 行（update.ps1 heredoc 修法 + beacon 觀測）
tests/llm-narrative.test.js                        — 30 行（buildMessages prompt 規格 + parseLLMJson）
tests/add-stop-hook.test.js                        — 30 行（Stop hook idempotent merge + backup）
tests/context-blob-schema.test.js                  — 29 行（截斷物件 + validateContextBlob 1MB）
tests/auto-comply-reads-file.test.js               — 29 行（IR-025 autoComply 讀檔 vs in-memory）
tests/session-counter.test.js                      — 28 行（counter 檔 read/increment + cleanup）
tests/pitfalls-no-cutoff.test.js                   — 28 行（V17_87_SHIPPED cutoff revert）
tests/mcp-tool-response-shape.test.js              — 28 行（composeToolResponse 單一 text part）
tests/bug-fingerprints.test.js                     — 28 行（指紋註冊表格式 + 5xx 通用指紋）
tests/sync-memory-files.test.js                    — 27 行（slugTitle + memoryFilename + fail-mode）
tests/bypass-handler.test.js                       — 27 行（OWNMIND_BYPASS 解析 + audit log）
tests/start-cmd-node-fallback.test.js              — 26 行（start.cmd Windows node fallback）
tests/lint-event-logger.test.js                    — 26 行（writeEvent rotate + extractViolatedWords）
tests/iron-rule-tier-helper.test.js                — 26 行（VALID_TIERS + normalizeTier + groupByTier）
tests/ingestion.test.js                            — 26 行（events / exemption / codex fingerprint）
tests/session-counter-block.test.js                — 25 行（block_count read/increment/reset）
tests/install-failed-beacon.test.js                — 25 行（FAIL 函式統一補 report_error）
tests/install-beacon-spool-fallback.test.js        — 25 行（beacon POST 失敗 spool fallback）
tests/upgrade-windows-file-lock.test.js            — 24 行（Windows file-lock 偵測訊息）
tests/report.test.js                               — 24 行（週/月 period range + 摩擦點分組）
tests/first-run-redirect.test.js                   — 24 行（first-run middleware redirect + fail-open）
tests/build-compliance-events.test.js              — 24 行（reply-lint 違規事件對應個人鐵律）
tests/admin-html-no-duplicate-const.test.js        — 24 行（admin HTML 內嵌 JS const 重複偵測）
tests/auto-retry-sync-token.test.js                — 23 行（sync_token 409 retry helper）
tests/require-fields.test.js                       — 22 行（requireFields + 敏感欄位遮蔽）
tests/me-change-password-status.test.js            — 22 行（change-password 舊密錯誤回 400）
tests/sync-token-endpoint.test.js                  — 20 行（generateSyncToken + validateSyncToken）
tests/init-compact-compliance-instruction.test.js  — 20 行（compact mode digest 含 compliance 指令）
package.json                                       — 1.26.10 → 1.26.11
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md / FILELIST.md                         — v1.26.11 條目
```

## v1.26.10 修改（國際化第十期 Part 3：tests/ 接續 15 檔英文化 — 軌道 B）

新增檔：
```
openspec/changes/archive/v1.26.10-i18n-tests-internal-part3/proposal.md      — v1.26.10 提案
openspec/changes/archive/v1.26.10-i18n-tests-internal-part3/tasks.md         — v1.26.10 任務清單
```

修改檔（15 個 tests/*.test.js + 版號 + 三語文件）：
```
tests/memory-error-classifier.test.js              — 38 行（PG / JS 錯誤分流 + 邊界回 fallback）
tests/debug-route-beacon-version.test.js           — 38 行（beacon trigger 強制 client_version NULL）
tests/privacy-redact.test.js                       — 37 行（信箱 / 手機 / 身分證代稱化 + allowlist）
tests/bug-report-spam-detector.test.js             — 37 行（Levenshtein 相似度 + 三條 spam 規則）
tests/language-lint-v1195.test.js                  — 36 行（白名單 case-insensitive bug + 漏字補充）
tests/iron-rule-tier-digest.test.js                — 36 行（buildIronRulesDigest tier 排序 + countByTier）
tests/conditional-sync.test.js                     — 36 行（cache token 比對 + fallback 流程）
tests/mcp-log-event-uuid.test.js                   — 35 行（logEvent UUID v4 + POST body 對齊）
tests/rule-enforcer-core.test.js                   — 34 行（純函式 enforceRule + bypass / advisory）
tests/mcp-tool-description-secret-warning.test.js  — 34 行（save / update / set_secret 描述警語）
tests/verification-command-handlers.test.js        — 33 行（command_matches / not_matches + 5 條鐵律 when/then）
tests/migration-017-bug-reports-id-serial.test.js  — 33 行（SQL sanity + SERIAL + index 重建）
tests/error-spool-mechanism.test.js                — 33 行（errors/ spool 上傳 + dirty tree 自動處理）
tests/bug-report-helpers.test.js                   — 33 行（confirm_string + spam block + rate-limit）
tests/install-prerequisite-auto-install.test.js    — 32 行（winget / brew / apt auto-install 卡控）
package.json                                       — 1.26.9 → 1.26.10
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md / FILELIST.md                         — v1.26.10 條目
```

## v1.26.9 修改（國際化第十期 Part 2：tests/ 中型 14 檔英文化 — 軌道 B）

新增檔：
```
openspec/changes/archive/v1.26.9-i18n-tests-internal-part2/proposal.md       — v1.26.9 提案
openspec/changes/archive/v1.26.9-i18n-tests-internal-part2/tasks.md          — v1.26.9 任務清單
```

修改檔（14 個 tests/*.test.js + 版號 + 三語文件）：
```
tests/activity-batch-dedup.test.js         — 56 行（含 v1.17.99 helper round-trip + dedup ON CONFLICT path）
tests/templates.test.js                    — 54 行（含 matchTemplate / extractTriggers 完整覆蓋）
tests/reply-lint.test.js                   — 52 行（含 IR-037 + IR-036 純函式 lint）
tests/admin-reset-password.test.js         — 52 行（含 v1.19.9 7 個場景 + bcrypt 端到端驗證）
tests/sweep-old-backups.test.js            — 49 行（含 find -mtime + IR-027 邏輯卡控）
tests/pre-commit-secret.test.js            — 49 行（含 PAT / OpenAI key fixture 改字串拼接避誤判）
tests/session-start-render.test.js         — 47 行（含廣播 / memory / tier summary 三大區塊）
tests/me-profile-put.test.js               — 47 行（含 PUT /profile 11 條斷言、隱私 + 競態防護）
tests/jargon-context-memory.test.js        — 46 行（含 IR-036 跨 reply 詞彙記憶）
tests/iron-rule-suggest.test.js            — 44 行（含 suggestSkillMdFormat round-trip）
tests/reply-lint-pending-spool.test.js     — 43 行（含 hook 條件 spool + 1MB rotate + UUID v4 dedup）
tests/auth-401-observability.test.js       — 43 行（含 maskApiKey + 401 path logger 形狀）
tests/reply-lint-hook-v1911.test.js        — 41 行（含分級顯示 + log 保底）
tests/migration-016-bug-reports.test.js    — 39 行（含 SQL schema 五表 + 索引齊全）
package.json                               — 1.26.8 → 1.26.9
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md / FILELIST.md                 — v1.26.9 條目
```

## v1.26.8 修改（修 secret-detect 路徑誤判 + pre-commit hook 動態指紋分派）

新增檔：
```
hooks/lib/select-block-fingerprint.js                                       — 純函式 helper：根據攔下原因動態選 bug-report 指紋
tests/git-pre-commit-fingerprint.test.js                                    — selectBlockFingerprint 11 條單元測試
openspec/changes/archive/v1.26.8-fix-secret-detect-and-hook-fingerprint/proposal.md — v1.26.8 提案
openspec/changes/archive/v1.26.8-fix-secret-detect-and-hook-fingerprint/tasks.md    — v1.26.8 任務清單
```

修改檔（2 個核心檔 + 1 個測試 + 版號 + 三語文件）：
```
shared/secret-detect.js                  — 加 SLASH_SEPARATED_PATH_REGEX、length heuristic 新增 `/` 分隔路徑排除
hooks/ownmind-git-pre-commit.js          — 引入 selectBlockFingerprint、main() 收集 blockReasons、formatBlockMessage 動態選指紋
tests/secret-detect-unit.test.js         — 新增 v1.26.8 區塊 8 條測試（路徑 allow / 2-segment shape 仍 block / 真實 PAT 仍 block）
package.json                             — 1.26.7 → 1.26.8
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md / FILELIST.md               — v1.26.8 條目
```

## v1.26.7 修改（Hotfix：Windows + Git Bash 升級失敗 — MSYS 路徑沒給 Node 正規化）

新增檔：
```
scripts/install-helpers/path-helpers.sh                              — 新增、提供 to_win_path() bash function（cygpath -m fallback to identity）
tests/path-to-win32.test.js                                          — 新增、17 個 unit test、mock process.platform=win32 驗 toWin32Path/toMsysPath round-trip
tests/path-helpers-bash.test.js                                      — 新增、7 個整合 test、spawn bash + 模擬 cygpath 驗 to_win_path() 行為
openspec/changes/archive/v1.26.7-hotfix-msys-path/proposal.md       — v1.26.7 hotfix 提案
openspec/changes/archive/v1.26.7-hotfix-msys-path/tasks.md          — v1.26.7 hotfix 任務清單
```

修改檔（4 個 sh 檔 + 版號 + 三語文件）：
```
hooks/ownmind-session-start.sh           — 加 source path-helpers.sh + OWNMIND_DIR_WIN、line 179 改用 _WIN
scripts/interactive-upgrade.sh           — 加 source + OWNMIND_DIR_WIN、line 133/213 改用 _WIN
scripts/verify-upgrade.sh                — 加 source + OWNMIND_DIR_WIN + CLAUDE_DIR_WIN、line 34/49 改用 _WIN（Vin 報的）
scripts/check-sync.sh                    — 加 source + OWNMIND_DIR_WIN + CLAUDE_DIR_WIN、line 53/71 改用 _WIN
package.json                             — 1.26.6 → 1.26.7
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md / FILELIST.md               — v1.26.7 條目
```

**未動**：`scripts/install-helpers/path-to-win32.cjs`（Node-side helper 早就存在、邏輯正確、只是沒人用、本次補上 sh-side 接線）

## v1.26.6 修改（國際化第十期 Part 1：tests/ 前 25 大檔英文化 — 軌道 B）

新增檔：
```
openspec/changes/archive/v1.26.6-i18n-tests-internal-part1/proposal.md
openspec/changes/archive/v1.26.6-i18n-tests-internal-part1/tasks.md
```

修改檔（25 個 tests/*.test.js + 版號 + 三語文件）：
```
tests/iron-rule-quality.test.js              — 150 行（含 5 個 describe 註解 + dogfood 範例 ir027/ir006/ir039 fixture 保留）
tests/verification.test.js                   — 141 行（含 CHECK_HANDLERS 5 種 / evaluateConditions / IR-008/012/002/009 場景）
tests/secret-detect-unit.test.js             — 132 行（regex/keyword/heuristic 三層、含 v1.19.13 assignment-style 收緊）
tests/ownmind-tty-echo.test.js               — 120 行（含 v1.17.73 結構性合約 8 種 contract case）
tests/reply-lint-hook.test.js                — 98 行（含 v1.17.96 Stop hook 整合 + activity POST schema）
tests/disable-details-snapshot.test.js       — 95 行（含 enrichActivityDetails + me.js pitfalls SQL 整合）
tests/memory-secret-guard.test.js            — 93 行（含 v1.19.13 matched_text / bot.example.com regression）
tests/self-check.test.js                     — 91 行（含 v1.17.66 collectEnv + v1.17.68 checkApiKeyFormat）
tests/ps1-windows-compat.test.js             — 87 行（含 v1.17.66 Bug #1/#6/#7 / Bug #4 try-finally）
tests/iron-rule-quality-skill-md.test.js     — 81 行（含 v1.18.0 S1-S9 schema lint）
tests/privacy-detect-unit.test.js            — 79 行（含 TW ID / email / phone + whitelist + false-positive defense）
tests/mcp-auto-update-cross-platform.test.js — 78 行（含 v1.17.23 update.ps1 + autostash fallback regression）
tests/me-pitfalls.test.js                    — 74 行（含 /api/me/pitfalls endpoint + memory.js system_auto compliance log）
tests/secret-mgmt.test.js                    — 68 行（含 upsert + delete tool + activity_log audit 不洩 value）
tests/iron-rule-origin-context.test.js       — 68 行（含 validate / render / inject / lint metadata round-trip）
tests/p3-update-event-semantics.test.js      — 67 行（含 update_applied/clean/failed 三分流 + lock atomic）
tests/reply-lint-hook-v1193-block.test.js    — 66 行（含 progressive block + MODE fallback + reason 寫 stderr）
tests/setup-wizard.test.js                   — 58 行（含 first-run detector + advisory lock + cache 行為）
tests/enrich-error.test.js                   — 58 行（含 stack 截短 + http_status regex + payload_summary 隱私）
tests/reply-lint-hook-v197.test.js           — 57 行（含 BLOCK_DOWNGRADE_LIMIT + block_count reset + privacy_check）
tests/upgrade-complete-beacon.test.js        — 56 行（含 IR-038 觀測補洞 + bash/PS1 beacon + retrySpool drain）
tests/me-report.test.js                      — 56 行（含 user-accessible /me/ + bcrypt + must_change_password）
tests/language-lint-v1193.test.js            — 56 行（含 Top 30 白名單 / proper noun / threshold by context / 80-char window）
tests/iron-rule-sync.test.js                 — 56 行（含 buildBigSkillMd + buildReferenceFile + syncToAllTools 6 個 target）
tests/flush-compliance-spool.test.js         — 56 行（含 SessionStart helper + 嚴格 stdout/stderr 空白契約）
package.json                                 — 1.26.5 → 1.26.6
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md / FILELIST.md                   — v1.26.6 條目
```

## v1.26.5 修改（國際化第九期：src/routes/ 內部註解 + user-facing 字串英文化 — 軌道 B + A）

新增檔：
```
openspec/changes/archive/v1.26.5-i18n-src-routes-internal/proposal.md
openspec/changes/archive/v1.26.5-i18n-src-routes-internal/tasks.md
```

修改檔（24 個 src/routes/ 檔 + 4 條 test 斷言 + package.json 補修）：
```
src/routes/memory.js                     — 194 行（init/SOP/CRUD 全部註解英化、保留 [團隊] prefix + DB-stored rule_title）
src/routes/me.js                         — 176 行（GET /report + /pitfalls 兩大 endpoint 註解英化、保留 UI report 字串）
src/routes/bug-reports.js                — 80 行（含 validateContextBlob 錯誤分流 regex 同步加 'exceeds'）
src/routes/admin.js                      — 77 行（含登入/setup/password 三個 endpoint 註解 + logger 英化、保留 user-facing UI 字串）
src/routes/activity.js                   — 75 行（含 autoEmitObservedTrigger 註解英化、保留 DB-stored audit context）
src/routes/broadcast.js                  — 70 行（含 admin/user 兩端註解 + logger 英化、validateBroadcastPayload 錯誤訊息全英化）
src/routes/usage/events.js               — 57 行（含 ingestion pipeline 註解 + validation 訊息英化）
src/routes/admin-iron-rule-upgrade.js    — 55 行（含 PUT /:id/upgrade 註解英化、保留 modal 互動字串）
src/routes/secret.js                     — 45 行
src/routes/setup.js                      — 37 行（保留 setup wizard user-facing 字串）
src/routes/session.js                    — 33 行（保留 月摘要 strings, 跨 server compress 用）
src/routes/debug.js                      — 28 行
src/routes/usage/stats.js                — 27 行
src/routes/admin-password-reset.js       — 25 行（保留 admin / user role 變更時的中文 UI 字串）
src/routes/me-narrative.js               — 21 行
src/routes/usage/exemptions.js           — 20 行
src/routes/usage/team-overview.js        — 19 行
src/routes/usage/admin-clients.js        — 18 行
src/routes/usage/pricing.js              — 14 行
src/routes/usage/team-stats.js           — 13 行
src/routes/handoff.js                    — 11 行
src/routes/admin-work-log.js             — 9 行
src/routes/usage/admin-audit.js          — 5 行
src/routes/export.js                     — 4 行
tests/pricing.test.js                    — 第 270 / 283 行斷言改成接受中英 (non-negative / must be a number)
tests/broadcast.test.js                  — 第 138 / 353 行斷言改成接受中英 (later than / visible set)
package.json                             — 1.26.3 → 1.26.5（補修 v1.26.4 漏掉的 1.26.3→1.26.4 升級）
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md                             — v1.26.5 條目
```

**刻意保留**：101 行中文、主要在 `me.js` (33) + `admin.js` (34) + `bug-reports.js` (10) + `memory.js` (7)。詳見 CHANGELOG 同名段落。

**驗證**：`npm test` 1956 pass / 0 fail；`node --check` 全過。

## v1.26.4 修改（國際化第八期：shared/ 內部註解英文化 — 軌道 B）

新增檔：
```
openspec/changes/archive/v1.26.4-i18n-shared-internal/proposal.md
openspec/changes/archive/v1.26.4-i18n-shared-internal/tasks.md
```

修改檔（26 個 shared/ 檔 + 1 個 test 斷言）：
```
shared/secret-detect.js          — 124 行註解英化（reason 字串保留中文）
shared/language-lint.js          — 107 行（AI-facing lint 訊息 + 中文偵測 regex 保留）
shared/verification.js           — 65 行（FIX_HINTS 全部保留中文，測試硬編碼比對）
shared/privacy-detect.js         — 52 行（PRIVACY_TYPE_LABELS 中文標籤保留）
shared/bug-fingerprints.js       — 48 行（含 17 條 description 翻英文）
shared/helpers.js                — 29 行（部署 / 刪除 trigger 詞保留）
shared/session-off-state.js      — 28 行
shared/privacy-redact.js         — 27 行（TYPE_LABEL_ZH 保留）
shared/device-fingerprint.js     — 27 行
shared/context-blob-schema.js    — 27 行（含 validation 錯誤訊息英化）
shared/scanners/opencode.js      — 24 行
shared/scanners/claude-code.js   — 23 行
shared/lint-event-types.js       — 21 行
shared/scanners/id-helper.js     — 20 行
shared/scanners/codex.js         — 19 行
shared/scanners/base.js          — 19 行
shared/validators/index.js       — 15 行
shared/scanners/vscode-telemetry.js — 15 行
shared/random-password.js        — 13 行
shared/iron-rule-tier.js         — 12 行（TIER_LABEL_ZH 中英雙語標題保留）
shared/compliance.js             — 10 行
shared/validators/jargon-explanation.js — 7 行
shared/validators/privacy-detect.js — 4 行
shared/validators/language-mixed-ratio.js — 4 行
shared/scanners/cursor.js        — 3 行
shared/scanners/antigravity.js   — 3 行
tests/context-blob-schema.test.js — 第 104 行斷言改成 /型別|wrong type/
package.json                     — 1.26.3 → 1.26.4
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md                     — v1.26.4 條目
```

**刻意保留**：見 proposal §Out of Scope（lint AI-facing 訊息 / Chinese trigger regex / 中文標籤 / `secret-detect.js` reason 字串等共 44 行）。

**驗證**：`npm test` 1956 pass / 0 fail；`node --check` 全過。

## v1.26.3 修改（國際化第七期：scripts/ 內部註解英文化 — 軌道 B）

新增檔：
```
openspec/changes/archive/v1.26.3-i18n-scripts-internal/proposal.md
openspec/changes/archive/v1.26.3-i18n-scripts-internal/tasks.md
```

修改檔（21 個 scripts/ 檔 + 2 個 test 斷言）：
```
scripts/install-helpers/self-check.cjs  — 97 行註解英化
scripts/reset-admin-password.js         — 57 行（含 HELP / 互動 prompt / 訊息全英化）
scripts/update.sh                       — 54 行
scripts/health-report-daily.sh          — 49 行（含 SQL alias / section header 英化）
scripts/verify-upgrade.sh               — 48 行（含 STDOUT 訊息英化）
scripts/interactive-upgrade.sh          — 45 行（含 FAIL/STEP/OK 訊息英化）
scripts/run-migrations.sh               — 35 行
scripts/install-helpers/add-post-tool-use-hook.cjs / add-stop-hook.cjs / run-scanner.sh / safe-spawn.cjs — 中型檔
scripts/lint-zh-only.js / migrate-verification.js / report-error.cjs / load-settings-safe.cjs / backfill-iron-rule-origin-context.js / audit-real-iron-rules-lint.js / check-sync.sh / path-to-win32.cjs / bootstrap.sh / report-error.sh — 小檔
tests/reset-admin-password-script.test.js — --help 斷言改英文
tests/add-stop-hook.test.js              — write failed 斷言改英文
package.json                             — 1.26.2 → 1.26.3
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md                             — v1.26.3 條目
```

**刻意保留**：`scripts/audit-real-iron-rules-lint.js` 內 2 處字串匹配字面值（'中英混雜'、'前 5 個'、用來抓 lintIronRule 中文錯誤訊息）。

**驗證**：`npm test` 1956 pass / 0 fail；`node --check` / `bash -n` 全過。

## v1.26.2 修改（國際化第六期：mcp/ 內部註解英文化 — 軌道 B）

新增檔：
```
openspec/changes/archive/v1.26.2-i18n-mcp-internal/proposal.md   — i18n 第六期提案
openspec/changes/archive/v1.26.2-i18n-mcp-internal/tasks.md      — 任務分解
```

修改檔（6 個 mcp/ 檔 + 軌道 A 補洞 4 條 user-facing 訊息）：
```
mcp/index.js                          — JSDoc 大頭 + 自動更新邏輯 + session-off/on 訊息英化（137 行翻完、保留 confirm_string="送出" + 個人鐵律 title）
mcp/ownmind-log.js                    — JSDoc + buffer / signal hook / client_event_id dedup 註解
mcp/lib/sync-token-retry.js           — JSDoc + 設計理由（多 session 寫入 409 自動 retry）
mcp/lib/compose-tool-response.js      — JSDoc + 視覺規則
mcp/lib/log-mcp-call.js               — JSDoc + helper 設計
mcp/lib/enrich-error.js               — JSDoc + 兩個函式說明
package.json                          — version 1.26.1 → 1.26.2
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md                          — v1.26.2 條目
```

**驗證**：`rg '\p{Han}' mcp/` 剩 3 行刻意保留（confirm_string 字面值 + 個人鐵律 title）；`node --check` 全過；`npm test` 1956 pass / 0 fail。

## v1.26.1 修改（修復 ownmind_report_bug 設計缺陷 — 自由回報路徑）

新增檔：
```
openspec/changes/archive/v1.26.1-bug-report-free-form/proposal.md   — 設計提案（escape hatch 指紋）
openspec/changes/archive/v1.26.1-bug-report-free-form/tasks.md      — 任務分解
```

修改檔（5 個產品檔 + 2 個測試）：
```
shared/bug-fingerprints.js               — 新增 clt_user_reported_other 指紋（clt 類別、free-form escape hatch）
src/routes/bug-reports.js                — POST / 的 400 錯誤訊息改寫、加 hint 指引使用 clt_user_reported_other
mcp/index.js                             — ownmind_report_bug 工具的 bug_fingerprint 欄位描述放寬：移除「must NOT be fabricated」、改說「沒匹配指紋時用 clt_user_reported_other」
hooks/ownmind-reply-lint.js              — block path + downgrade path 兩處 stderr 訊息加 disambiguation：lint_context_memory_missing 只該給「這次 lint 誤判」用、其他類別改用 clt_user_reported_other
hooks/ownmind-git-pre-commit.js          — formatBlockMessage 的 stderr 訊息加 disambiguation：mem_iron_rule_blocking_commit_no_fingerprint 只該給「這次 commit 擋下不對」用、其他類別改用 clt_user_reported_other
tests/bug-fingerprints.test.js           — 新測試確認 clt_user_reported_other 已註冊
tests/bug-report-helpers.test.js         — 新測試確認 withReportSuggestion 接受新指紋
package.json                             — version 1.26.0 → 1.26.1
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md                             — v1.26.1 條目
```

**驗證**：`npm test` 1956 pass / 0 fail（多 2 條新測試、無回歸）。

## v1.26.0 修改（國際化第五期：hooks/ 內部註解英文化 — 軌道 B 首發）

新增檔：
```
openspec/changes/archive/v1.26.0-i18n-hooks-internal/proposal.md   — i18n 第五期提案（軌道 B 首發）
openspec/changes/archive/v1.26.0-i18n-hooks-internal/tasks.md      — 任務分解
```

修改檔（軌道 B 內部註解英化、20 個 hooks 檔）：
```
hooks/ownmind-reply-lint.js              — JSDoc 大頭 + IR-027 spec + MODE 註解 + 違規計數 partial-failure 註記 + readTranscriptTail JSDoc + formatBanner JSDoc + formatBlockReason JSDoc + 各種行內 // 註解（178 行）
hooks/ownmind-tty-echo.cjs               — JSDoc 大頭 + 主路徑 fallback 註解 + extractBanners / formatBlock JSDoc + writeFallback 註解
hooks/ownmind-usage-scanner.js           — JSDoc 大頭 + acquireLock JSDoc + 各種行內註解 + isDirectRun 註解
hooks/ownmind-git-pre-commit.js          — JSDoc 大頭 + getStagedAddedLines / checkStagedDiffForSecrets JSDoc + fetchAndCacheRules JSDoc + 各種行內註解
hooks/ownmind-git-post-commit.js         — JSDoc 大頭 + tier 註解 + version-tag sync check 註解
hooks/ownmind-iron-rule-check.js         — JSDoc 大頭 + trigger fallback / API envelope 兼容 / commit vs deploy 模式註解
hooks/ownmind-session-start.js           — JSDoc 大頭 + session-off 清除註解 + bug report notifications 註解
hooks/ownmind-verify-trigger.js          — fallback 字串 '未命名規則' → '(untitled rule)'（軌道 A 補洞）
hooks/lib/flush-compliance-spool.js      — JSDoc 大頭 + I2 fix 註解 + restoreOrCleanup / readCredentialsInline JSDoc
hooks/lib/conditional-sync-cli.js        — JSDoc 大頭（為什麼存在 / 流程 / review fixes）+ fetchIronRuleList / writeStdoutAsync JSDoc + dynamic import 註解
hooks/lib/conditional-sync.js            — JSDoc 大頭（4 條 refresh 規則 / 設計）+ readCache / shouldRefreshCache / fetchSyncTokenLight / fetchInitFull / writeCache / runConditionalSync JSDoc + 各 step 註解
hooks/lib/session-counter.js             — JSDoc 大頭（schema / 設計原則）+ 5 個函式 JSDoc + cleanupStale 註解
hooks/lib/rule-enforcer.js               — JSDoc 大頭（決定 action 邏輯）+ enforceRule / enforceRules / decideAction JSDoc
hooks/lib/lint-event-logger.js           — JSDoc 大頭 + writeEvent / extractViolatedWords JSDoc + rotate 註解
hooks/lib/build-compliance-events.js     — JSDoc 大頭（v1.20.4 中性事件常數對應）+ buildComplianceEvents JSDoc
hooks/lib/bypass-handler.js              — JSDoc 大頭（usage / 設計原則）+ parseBypass / isBypassed / logBypass JSDoc
hooks/lib/flush-pending-banners.js       — JSDoc 大頭 + 行內註解
hooks/lib/sync-memory-files.js           — JSDoc 大頭 + buildMemoryIndex 內 3 條 MEMORY.md user-facing 字串英化（軌道 A 補洞）
hooks/lib/render-session-context.js      — JSDoc 大頭 + 廣播 / tier summary 註解
hooks/lib/session-start-output.js        — JSDoc 大頭
package.json                             — version 1.25.0 → 1.26.0
README.md                                — 版號同步
CHANGELOG.md                             — v1.26.0 條目
```

**驗證**：`rg '\p{Han}' hooks/` 剩 1 行（reply-lint.js:658 刻意保留的功能性 token）；`node --check` 全部過；`npm test` 1954 pass / 0 fail。

## v1.25.0 修改（國際化第四期：Server-side memory route + INSTRUCTIONS_SOP 英文化）

新增檔：
```
openspec/changes/archive/v1.25.0-i18n-memory-route/proposal.md   — i18n 第四期提案
openspec/changes/archive/v1.25.0-i18n-memory-route/tasks.md      — 任務分解
```

修改檔（user-facing 字串翻譯）：
```
src/routes/memory.js                        — UPDATE_PROMPT + checkSyncToken errors + INSTRUCTIONS_SOP 288 行 + 25 處 HTTP error response + iron rule lint error/hint + is_test guard + alertText + compliance digest section + detectedTool fallback
tests/auto-retry-sync-token.test.js         — sync_token retry 訊息斷言英化
tests/memory-upgrade-test.test.js           — name_prefix + is_test guard 斷言英化
tests/init-compact-compliance-instruction.test.js — digest section 視窗放寬 800 → 1500（英文比中文長）
package.json                                — version 1.24.0 → 1.25.0
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md                                — v1.25.0 條目（含 Track A 總結）
```

## v1.24.0 修改（國際化第三期：reply-lint + validator 訊息英文化）

新增檔：
```
openspec/changes/archive/v1.24.0-i18n-reply-lint/proposal.md   — i18n 第三期提案
openspec/changes/archive/v1.24.0-i18n-reply-lint/tasks.md      — 任務分解
```

修改檔（user-facing 字串 + Claude 行為性 prompt 翻譯）：
```
hooks/ownmind-reply-lint.js                 — session-off 提醒 + bug-report tip + formatBanner + formatPrivacySummary + formatDowngradeNotice + _EVENT_DISPLAY_NAMES + formatBlockReason（完整 + 簡短 + 標註要求）
shared/lint-event-types.js                  — EVENT_DISPLAY_NAMES 共用映射英化
shared/validators/language-mixed-ratio.js   — 違規訊息英化
shared/validators/jargon-explanation.js     — 違規訊息英化
shared/validators/privacy-detect.js         — 違規訊息 + formatPrivacySummary 英化
tests/reply-lint-hook.test.js               — banner header / Reply quality lint 斷言
tests/reply-lint-hook-v1193-block.test.js   — Please rewrite / parenthetical / variable names 斷言
tests/reply-lint-hook-v197.test.js          — blocked X times in a row / privacy 斷言
tests/reply-lint-hook-v1911.test.js         — session block #N / quoted-block annotation 斷言
tests/build-compliance-events.test.js       — 中文 prefix → 英文 prefix 斷言
package.json                                — version 1.23.0 → 1.24.0
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md                                — v1.24.0 條目
```

## v1.23.0 修改（國際化第二期：SessionStart 介面英文化）

新增檔：
```
openspec/changes/archive/v1.23.0-i18n-session-start/proposal.md   — i18n 第二期提案
openspec/changes/archive/v1.23.0-i18n-session-start/tasks.md      — 任務分解
```

修改檔（user-facing 字串翻譯：中文 → 英文）：
```
hooks/ownmind-session-start.js              — 招牌 + 6 個 Markdown header + 4 處 notification message + footer line
hooks/lib/render-session-context.js         — 廣播渲染（CTA / snooze / 剩餘數 / SYSTEM action required）+ 各 section header + tier summary + footer
tests/session-start-render.test.js          — 13 處中文 assertion 改 English
package.json                                — version 1.22.0 → 1.23.0
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md                                — v1.23.0 條目
```

## v1.22.0 修改（國際化第一期：user-facing 字串英文化）

新增檔：
```
CLAUDE.md                                                — repo 根目錄 dev 指引、雙軌國際化規則文件（v1.21.0 後加）
openspec/changes/archive/v1.22.0-i18n-user-facing/proposal.md   — i18n 第一期提案
openspec/changes/archive/v1.22.0-i18n-user-facing/tasks.md      — 任務分解
openspec/changes/archive/v1.22.0-i18n-user-facing/spec.md       — 規格 + scenarios + style examples
```

修改檔（user-facing 字串翻譯：中文 → 英文、CJK 標點 → ASCII）：
```
mcp/index.js                                — 19 個 TOOLS description + TYPE_MAP 22 條 + 28 條 TIPS + 7 處離線通知 + 4 處 throw error + renderBroadcasts + formatTag 改 ASCII 括號
mcp/offline.js                              — replayQueue 兩條訊息
mcp/lib/compose-tool-response.js            — tag/tip 連接符 CJK `：` → ASCII `:`、`技巧提示` → `Tip`
hooks/ownmind-git-pre-commit.js             — 7 處 console / 訊息字串、`【】` → `[]`
hooks/ownmind-git-post-commit.js            — 7 處 console / 訊息字串、`【】` → `[]`
hooks/ownmind-iron-rule-check.js            — 版號卡控 + 鐵律觸發 + 鐵律攔截 + commit 通過訊息、`【】` → `[]`
hooks/ownmind-tty-echo.cjs                  — banner 抽取 regex 改雙形相容（接受 `【】` 跟 `[]`、給尚未翻譯的舊檔 backward compat）、輸出 header 改 `[OwnMind ${version}]`
tests/mcp-tool-description-secret-warning.test.js — 警語 regex 加 English keyword
tests/secret-mgmt.test.js                   — irreversible 警告 regex 加 English
tests/mcp-tool-response-shape.test.js       — fixture + 斷言改 `[OwnMind ...]` 跟 ASCII `:`
tests/ownmind-tty-echo.test.js              — header regex 改 `[OwnMind v[\d.]+]`
tests/offline.test.js                       — 訊息斷言改 `partially failed` / `complete`
tests/tip-every-call.test.js                — `formatTag("技巧提示")` → `formatTag("Tip")`
package.json                                — version 1.21.0 → 1.22.0
README.md / docs/README.zh-TW.md / docs/README.ja.md — 三語版號同步
CHANGELOG.md                                — v1.22.0 條目
```

Defer 到 v1.23.0（單獨 spec、變更面較大）：
- `hooks/ownmind-reply-lint.js`（Claude 重寫指令 30+ 行行為性 prompt）
- `hooks/ownmind-session-start.js` + `hooks/lib/render-session-context.js`（每次新對話載入訊息）
- `src/routes/memory.js` 28 處 server-side API response brand banner

## v1.20.1 修改（Dashboard 個人版完工：Portal 4 頁 + Preference 3 頁 + 登入頁 + 守門員）

新增檔（共用元件 + 語系 context + API 客戶端 + 後端 PUT 測試 + 登入頁 + 守門員）：
```
client/src/components/common/Sidebar.jsx       — 側邊欄、4 區段 + 13 條導航、按角色顯示、手風琴折疊
client/src/components/common/TopBar.jsx        — 上方列、標題 + 語系切換 + 角色模擬器 + 頭像選單
client/src/components/common/FilterBar.jsx     — 篩選列、日期 + 專案 + 關鍵字（受控元件）
client/src/components/common/Footer.jsx        — 頁尾、版本號 + 版本紀錄毛玻璃彈窗
client/src/components/common/Modal.jsx         — 通用彈窗、ESC + 點背景關閉、3 尺寸 + 毛玻璃模式
client/src/components/common/RoleBadge.jsx     — 角色標籤、3 種角色配色
client/src/components/common/StatCard.jsx      — 統計卡、KPI 顯示用
client/src/components/common/Layout.jsx        — 頁面包裝、所有路由共用
client/src/components/common/RequireAuth.jsx   — 路由守門員、沒 api_key 自動導 /login 並記下原本想去的路徑
client/src/components/common/RequireFreshPassword.jsx — 強制改密碼守門員、must_change_password=true 時強制導 /preference/security（IR-122 卡控）
client/src/components/common/index.js          — barrel export（含新增 RequireAuth）
client/src/i18n/LocaleContext.jsx              — LocaleProvider + useLocale + useT hook、含 localStorage 持久化
client/src/api/auth.js                         — localStorage 管理 api_key + must_change_password（get/set/clear，含隱私模式 try/catch）
client/src/api/client.js                       — fetch 封裝、自動帶 Bearer header、統一回 { ok, data, error, status }、401 自清 token + 廣播 auth-expired event（含 1s debounce 避免 burst 多次 dispatch）；加 API_BASE 動態偵測 + resolveUrl helper（v1.20.1 hotfix 修 prod /ownmind/ 前綴漏帶）
client/src/api/index.js                        — barrel export
client/src/api/README.md                       — 用法 + 設計取捨
client/src/pages/LoginPage.jsx                 — 登入頁、不包 Layout、handle must_change_password redirect + 已登入導回原本想去的頁
client/src/pages/Preference/SecurityPage.jsx   — 帳密修改頁、3 欄表單、trim 防空白、setTimeout cleanup、失敗清新密欄位
client/src/pages/Preference/ProfilePage.jsx    — 個人資料頁、GET 載入 + PUT 存 name、role 白名單防破窗、toLocaleString 帶 BCP-47 locale
client/src/pages/Preference/VaultPage.jsx      — 密鑰管理頁、list + 點顯示才解密 + 60 秒自動隱藏、新增/編輯/刪除（紅色 + confirm dialog IR-046）、useRef 存 timer 確保 unmount 清乾淨
client/src/pages/Portal/UsagePage.jsx           — 用量分析主頁、三分頁標籤 + 時段切換條（7d/14d/30d/all）、useEffect 監聽 range refetch、tab 切換不重打
client/src/pages/Portal/UsageMine.jsx           — 個人區塊、4 張 KPI 卡（場次/事件/最後活動/合規率）+ 專案/鐵律/版本/活動四表
client/src/pages/Portal/UsageTeam.jsx           — 團隊區塊、成員表 + 3 張 recharts 圖（日趨勢 LineChart / 24h BarChart / 星期 BarChart）+ 事件類型 + 版本
client/src/pages/Portal/UsageProjects.jsx       — 全團隊專案、list + 點 row 開 Modal 看貢獻成員（contributors）細項
client/src/pages/Portal/ProjectHistoryPage.jsx — 專案歷程頁、GET /api/memory/type/project + Modal 看完整 content
client/src/pages/Portal/HandoffsPage.jsx       — 工作交接頁、GET /handoff/pending + PUT /:id/accept、profile 失敗 disable accept 防空字串污染 DB
client/src/pages/Portal/ReportsPage.jsx        — 回報紀錄頁、GET /bug-reports + GET /:id Modal 詳情、403 i18n mapping
client/src/utils/fmtDate.js                    — 共用日期格式工具、BCP-47 locale + isNaN 防 invalid Date
tests/me-profile-put.test.js                   — PUT /api/me/profile 11 條 source-match 測試（含 trim / whitelist / rowCount=0 / IR-038）
tests/me-change-password-status.test.js        — 守住舊密錯誤必須回 400 不回 401（避免 client.js 401 burst handler 誤踢用戶回 /login）
```

修改檔：
```
client/src/App.jsx                             — 加 /login 路由、其他路由包 RequireAuth + RequireFreshPassword、useEffect listen auth-expired event 自動 navigate /login；加 renderPage helper、/preference/security 接 SecurityPage、/portal/usage 接 UsagePage
src/routes/me.js                               — 補 PUT /profile endpoint + POST /change-password 舊密錯誤改回 400（從 401）
mcp/ownmind-log.js                             — 抽 export localDateOnly(date) helper、logEvent 改用、同源避免 test / prod 時區算法分歧
tests/mcp-log-event-uuid.test.js               — import localDateOnly 用同源 local date 計算、修跨午夜 UTC vs 台北邊界 flake
client/src/main.jsx                            — 包 LocaleProvider、加 TitleSync 連動 doc title、createRoot 加 window cache 修 HMR 警告、basename 改用 document.baseURI 動態偵測（hotfix 寫死 /ownmind/dashboard 導致本機 docker 部署 SPA 不渲染）
client/index.html                              — 加 <base href="./"> 讓 baseURI = 「index.html 所在資料夾絕對 URL」、basename / API_BASE 動態偵測得以正確排除 SPA sub-route
client/src/i18n/zh.json                        — 補新增的 i18n key（30 → 74 個 → 加 usage.* ~40 個鍵 / tab / range / col / weekday / mine / team / projects 分群）
openspec/changes/archive/v1.20.1-portal-pages/tasks.md — 從 stub 展開成 11 個子任務（3.0~3.10）含 TDD steps、依賴圖、推進順序
docker-compose.yml                             — 拿掉 db/001_init.sql 到 docker-entrypoint-initdb.d 的 mount、由 migration runner 統管（fix 既有設計衝突、獨立 commit 15d1d26）；加 postgres healthcheck + api depends_on 長形式 condition: service_healthy 卡控啟動順序（v1.20.1-db-healthcheck hotfix）
package.json                                   — version 1.20.0 → 1.20.1
client/package.json                            — version 1.20.0 → 1.20.1
CHANGELOG.md                                   — v1.20.1 release note（步驟 1+2 + 步驟 3 全 11 個子任務完工紀錄）
FILELIST.md                                    — 本檔
```

---

## v1.20.0 修改（後台前端基礎建設）

新增檔：
```
client/                                                       — 前端 SPA 目錄（React 19 + Vite 8 + Tailwind v4）
client/package.json                                           — 前端套件依賴鎖定
client/vite.config.js                                         — Vite 編譯設定（base './' + outDir ../src/public/dashboard）
client/index.html                                             — SPA 入口
client/.gitignore                                             — 排除 node_modules / dist / .vite
client/src/main.jsx                                           — React root render + BrowserRouter（basename 由 import.meta.env.PROD 判斷）
client/src/App.jsx                                            — 路由骨架 + 三角色守衛預留位
client/src/index.css                                          — Tailwind v4 @theme 北歐色票
client/src/design-tokens/colors.js                            — JS 端設計 token
client/src/i18n/index.js                                      — t(key, locale, params) 翻譯函式
client/src/i18n/zh.json                                       — 繁中字典（唯一真實來源、30 個起手 key）
client/src/i18n/en.json                                       — 英文翻譯（編譯產出）
client/src/i18n/ja.json                                       — 日文翻譯（編譯產出）
client/src/i18n/glossary.json                                 — 術語固定對照（20 個品牌專業詞）
client/src/i18n/en.override.json                              — 英文人工強制覆寫字典
client/src/i18n/ja.override.json                              — 日文人工強制覆寫字典
client/src/i18n/README.md                                     — i18n 維護流程說明
client/src/scripts/translate.mjs                              — 編譯時自動翻譯腳本（OpenAI 相容 API + manual fallback）
scripts/lint-zh-only.js                                       — 中英混雜 lint（掃 client/src JSX/JS、抓寫死英文文案）
.dockerignore                                                 — Docker build 排除清單
openspec/changes/archive/v1.20.0-frontend-foundation/proposal.md      — 本版規格（藍綠並存 + 三原則）
openspec/changes/archive/v1.20.0-frontend-foundation/tasks.md         — 本版任務清單
openspec/changes/archive/v1.20.1-portal-pages/proposal.md             — 下版規格 stub（Portal + Preference 共 7 頁）
openspec/changes/archive/v1.20.1-portal-pages/tasks.md                — 同上 task stub
openspec/changes/archive/v1.20.2-fix-hint/proposal.md                 — 提案：鉤子 recent_event_exists 失敗訊息加上具體 ownmind_report_compliance 呼叫範例
openspec/changes/archive/v1.20.2-fix-hint/spec.md                     — 規格：5 個 GIVEN/WHEN/THEN scenario
openspec/changes/archive/v1.20.2-fix-hint/tasks.md                    — 任務清單
tests/auto-comply-reads-file.test.js                          — v1.20.2 follow-up #1：3 個守備 case（in-memory 空 + 檔案有資料 / 反證 / 合併情境）證明 autoComply 應讀檔案
mcp/lib/sync-token-retry.js                                   — v1.20.2 follow-up #2：兩個純函式 helper（shouldRetryForSyncToken + applyNewToken）給 callApi 自動 retry 用
tests/auto-retry-sync-token.test.js                           — v1.20.2 follow-up #2：17 個守備 case（GET 不 retry / 500 不 retry / 非 sync_token 訊息不 retry / newToken null 防呆等）
tests/jargon-context-memory.test.js                           — v1.20.2 follow-up #3：11 個守備 case（IR-036 跨 reply 詞彙記憶、4 種解釋格式 / 向後相容 / null 防呆）
shared/session-off-state.js                                   — v1.20.3：session 暫時關閉開關狀態檔讀寫（read / write / clear / increment tick / isOff 共 5 個純函式、24 小時 TTL）
tests/session-off-state.test.js                               — v1.20.3：15 個守備 case（read / write / clear / increment / isOff / 24h 過期 / 損毀防呆）
openspec/changes/archive/v1.20.3-session-toggle/proposal.md           — 提案：/ownmind-off + /ownmind-on slash 指令、暫時關閉鉤子
openspec/changes/archive/v1.20.3-session-toggle/spec.md               — 規格：8 個 GIVEN/WHEN/THEN scenario
openspec/changes/archive/v1.20.3-session-toggle/tasks.md              — 任務清單
shared/lint-event-types.js                                    — v1.20.4：lint 事件常數模組（LINT_LANGUAGE_MIXED_RATIO / LINT_JARGON_EXPLANATION_REQUIRED / LINT_PRIVACY_CHECK）+ findUserRuleByEvent 查表工具
openspec/changes/archive/v1.20.4-lint-rule-neutralize/proposal.md     — 提案：產品碼去個人鐵律編號、改用中性事件常數
openspec/changes/archive/v1.20.4-lint-rule-neutralize/spec.md         — 規格：7 個 GIVEN/WHEN/THEN scenario
openspec/changes/archive/v1.20.4-lint-rule-neutralize/tasks.md        — 任務清單
shared/validators/jargon-explanation.js                       — v1.21.0 validator：包裝既有行話檢查邏輯
shared/validators/language-mixed-ratio.js                     — v1.21.0 validator：中英混雜檢查、threshold 可調
shared/validators/privacy-detect.js                           — v1.21.0 validator：隱私偵測（從 lint hook 抽出）
shared/validators/index.js                                    — v1.21.0：validator 註冊表 + findValidator / extractEnabledValidators
tests/validators/registry.test.js                             — v1.21.0：16 個守備 case（註冊表 / 查找 / 抽取啟用 / 介面合約）
openspec/changes/archive/v1.21.0-lint-validator-architecture/proposal.md — 提案：lint 規則驅動架構
openspec/changes/archive/v1.21.0-lint-validator-architecture/spec.md   — 規格：8 個 GIVEN/WHEN/THEN scenario
openspec/changes/archive/v1.21.0-lint-validator-architecture/tasks.md  — 任務清單
openspec/changes/archive/v1.20.2-admin-pages/proposal.md              — 規格 stub（Team + Bugs）
openspec/changes/archive/v1.20.2-admin-pages/tasks.md                 — 同上 task stub
openspec/changes/archive/v1.20.3-super-pages/proposal.md              — 規格 stub（Config + Broadcast + Audit）
openspec/changes/archive/v1.20.3-super-pages/tasks.md                 — 同上 task stub
openspec/changes/archive/v1.20.4-legacy-retire/proposal.md            — 規格 stub（舊版 301 轉址退役）
openspec/changes/archive/v1.20.4-legacy-retire/tasks.md               — 同上 task stub
```

修改檔：
```
package.json            — 加 build:client / dev:client / translate:client script、版號升 1.20.0
Dockerfile              — 改 multi-stage build（stage 1 編譯前端 → stage 2 COPY dist 進 src/public/dashboard）
.gitignore              — 加 client/node_modules / client/dist / src/public/dashboard / i18n 翻譯快取
src/app.js              — 新增 /dashboard 路由 + SPA fallback（舊 /admin + /me 完全不動）
.claude/launch.json     — 加 Vite dev server entry（dev:client 用）
README.md               — 版號 v1.20.0
docs/README.zh-TW.md    — 版號 v1.20.0
docs/README.ja.md       — 版號 v1.20.0
CHANGELOG.md            — 加 v1.20.0 段（藍綠並存 + 三原則 + e2e 測試結果 + 修 bug 紀錄）
FILELIST.md             — 加 v1.20.0 段
```

---

## v1.19.20 修改（Critical 鐵律卡控擴充：4 條 Bash 指令樣式 detector）

新增檔：
```
tests/verification-command-handlers.test.js                  — 27 個 unit test（含 IR-018/023/043/046 when/then 場景）
openspec/changes/archive/v1.19.20-iron-rule-enforcement-finishing/proposal.md  — 規格（含 v1.19.6/7 完工進度表）
openspec/changes/archive/v1.19.20-iron-rule-enforcement-finishing/spec.md      — 場景測試規格
openspec/changes/archive/v1.19.20-iron-rule-enforcement-finishing/tasks.md     — 任務清單與鐵律觸發 checklist
```

修改的既有檔：
```
shared/verification.js                                       — 新增 command_matches / command_not_matches handler + FIX_HINTS
hooks/ownmind-iron-rule-check.js                             — detect 不到 trigger 時 fallback 成 'command'、context 加 command 欄位、reminder 避開 command trigger；補修 API envelope 兼容（rules.filter 靜默 throw bug）
package.json / package-lock.json                             — version 1.19.19 → 1.19.20
README.md / docs/README.zh-TW.md / docs/README.ja.md         — Current version → v1.19.20
CHANGELOG.md                                                 — v1.19.20 條目
```

雲端使用者自訂規則更新（透過 ownmind_update API、4 條規則升 critical + 加 verification、不寫死在程式碼）：
```
規則 #1（Docker 編譯快取）  — verification: when docker build → then --no-cache
規則 #2（Docker Compose 部署一致性） — verification: when docker build → then compose
規則 #3（Windows SSH 工具選擇）  — verification: 不能含 sshpass
規則 #4（長指令背景保護）  — verification: when 背景跑長指令 → then 必須含 nohup
4 條都加 tag 'trigger:command'
具體對應到的鐵律編號是使用者個人記憶、不在此公開文件中引用。
```

---

## v1.19.19 修改（全站 requireFields helper：API 必填欄位錯誤訊息可偵錯化）

新增檔：
```
src/utils/require-fields.js                                  — 共用必填欄位 helper、回 missing/received/expected、自動遮蔽敏感欄位
tests/require-fields.test.js                                 — 18 個 unit test（含安全關鍵的敏感遮蔽 case）
openspec/changes/archive/v1.19.19-require-fields-helper/proposal.md     — 提案：背景、設計、移植範圍、風險檢查點
openspec/changes/archive/v1.19.19-require-fields-helper/tasks.md        — 任務清單與鐵律觸發 checklist
```

修改的既有檔：
```
src/routes/session.js                                        — POST / 改用 requireFields
src/routes/admin.js                                          — POST /users 改用 requireFields
src/routes/handoff.js                                        — POST / 改用 requireFields
src/routes/memory.js                                         — POST / 與 POST /batch-sync-standard 改用 requireFields
src/routes/secret.js                                         — POST / 改用 requireFields（value 自動遮蔽）
src/routes/usage/pricing.js                                  — POST / 統一改用 requireFields
package.json / package-lock.json                             — version 1.19.18 → 1.19.19
README.md / docs/README.zh-TW.md / docs/README.ja.md         — Current version → v1.19.19
CHANGELOG.md                                                 — v1.19.19 條目
```

---

## v1.19.18 修改（安全：npm audit fix 修補三個中度漏洞）

修改的既有檔：
```
package.json                                                 — version 1.19.17 → 1.19.18
package-lock.json                                            — qs 6.15.0→6.15.2、ip-address 10.1.0→10.2.0、express-rate-limit 8.3.2→8.5.2
README.md / docs/README.zh-TW.md / docs/README.ja.md         — Current version → v1.19.18
CHANGELOG.md                                                 — v1.19.18 條目
```

新增檔：
```
openspec/changes/archive/v1.19.18-security-audit-fix/proposal.md     — 提案：背景、設計、範圍、風險檢查點
openspec/changes/archive/v1.19.18-security-audit-fix/tasks.md        — 任務清單與鐵律觸發 checklist
```

---

## v1.19.17 修改（hotfix：錯誤回報後台 modal 按鈕無反應）

修改的既有檔：
```
src/public/index.html                                        — 4 處 classList .show → .active
tests/admin-html-no-duplicate-const.test.js                  — 加 grep 防 'show' class 復發的 case
package.json                                                 — version 1.19.16 → 1.19.17
README.md / docs/README.zh-TW.md / docs/README.ja.md         — Current version → v1.19.17
CHANGELOG.md                                                 — v1.19.17 條目
```

---

## v1.19.16 修改（hotfix：admin 後台登入頁 SyntaxError）

新增檔：
```
tests/admin-html-no-duplicate-const.test.js                  — 防止 iruUpdateTier 內 const cached 重複宣告復發
```

修改的既有檔：
```
src/public/index.html                                        — 砍第 1948 行重複的 const cached、重用第 1926 行
package.json                                                 — version 1.19.15 → 1.19.16
README.md / docs/README.zh-TW.md / docs/README.ja.md         — Current version → v1.19.16
CHANGELOG.md                                                 — v1.19.16 條目
```

---

## v1.19.15 修改（bug_reports id 從 BIGSERIAL 改 SERIAL）

新增檔：
```
openspec/changes/archive/v1.19.15-bug-reports-id-serial/proposal.md  — 提案：為什麼改型別 + 安全保證
openspec/changes/archive/v1.19.15-bug-reports-id-serial/tasks.md     — 任務清單
db/017_bug_reports_id_to_serial.sql                          — DROP + CREATE 重建 5 表、id 用 SERIAL
tests/migration-017-bug-reports-id-serial.test.js            — 12 個測試：sanity check + DROP + 型別 + CHECK + index
```

修改的既有檔：
```
package.json                                                 — version 1.19.14 → 1.19.15
README.md / docs/README.zh-TW.md / docs/README.ja.md         — Current version → v1.19.15
CHANGELOG.md                                                 — v1.19.15 條目
```

---

## v1.19.14 修改（錯誤回報工具：使用者 ⇄ 開發者雙向通知）

新增檔：
```
openspec/changes/archive/v1.19.14-bug-report-tool/proposal.md  — 提案：四版設計演進（經三輪 Gemini 對抗審查）
openspec/changes/archive/v1.19.14-bug-report-tool/spec.md      — 規格：60+ 個 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.19.14-bug-report-tool/tasks.md     — 任務拆解：含 v4.1 校正
db/016_bug_reports.sql                                    — 5 張新表 + 6 個 CHECK + 6 個 index
shared/bug-fingerprints.js                                — 錯誤指紋註冊表（16 個指紋、6 個前綴分類）
shared/context-blob-schema.js                             — 對話片段聯合型別 + 驗證
shared/privacy-redact.js                                  — 把個資樣式替換成代稱（信箱／身分證／手機）
shared/device-fingerprint.js                              — 主機指紋（node-machine-id + 安裝路徑 → SHA-256）
src/utils/bug-report-helpers.js                           — 純函式 helpers（confirm_string 驗證、查冷靜期/封鎖、組旗標）
src/services/bug-report-spam-detector.js                  — spam 偵測器（Levenshtein + 三條規則）
src/routes/bug-reports.js                                 — 11 個 API 端點
tests/migration-016-bug-reports.test.js                   — 24 個測試：表結構 + index + CHECK constraint
tests/bug-fingerprints.test.js                            — 14 個測試：指紋註冊表 + 查詢 API
tests/context-blob-schema.test.js                         — 19 個測試：聯合型別 + 驗證
tests/privacy-redact.test.js                              — 11 個測試：代稱化 + 同值同代稱
tests/device-fingerprint.test.js                          — 9 個測試：主機指紋穩定性 + fallback
tests/bug-report-helpers.test.js                          — 16 個測試：所有 helpers
tests/bug-report-spam-detector.test.js                    — 14 個測試：三條規則 + Levenshtein
```

修改的既有檔：
```
src/app.js                                                — 註冊 /api/bug-reports 路由
src/routes/memory.js                                      — 寫入被擋的回應加 suggest_report 旗標
mcp/index.js                                              — 加 ownmind_report_bug MCP 工具
hooks/ownmind-session-start.js                            — 加錯誤回報通知段（雙軌：admin + reporter）
scripts/update.sh                                         — 加 node-machine-id 安裝步驟
scripts/update.ps1                                        — 加 node-machine-id 安裝步驟（Windows）
package.json                                              — version 1.19.13 → 1.19.14、加 node-machine-id ^1.1.12 依賴
README.md / docs/README.zh-TW.md / docs/README.ja.md      — Current version → v1.19.14
CHANGELOG.md                                              — v1.19.14 條目
```

---

## v1.19.13 修改（掃密 keyword 偵測收緊、降低誤判）

新增檔：
```
openspec/changes/archive/v1.19.13-secret-detect-keyword-tighten/proposal.md  — 提案：value-side keyword 從寬鬆比對改賦值樣式
openspec/changes/archive/v1.19.13-secret-detect-keyword-tighten/spec.md      — 規格：S1～S5 共 20+ 個 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.19.13-secret-detect-keyword-tighten/tasks.md     — 任務拆解：Phase 0～6
```

修改的既有檔：
```
shared/secret-detect.js                                              — value-side keyword 改賦值 regex；matched_text 截 80 字回傳；長度啟發式排除點分隔識別字
src/utils/memory-secret-guard.js                                     — 400 body 加 matched_text
tests/secret-detect-unit.test.js                                     — +27 case：S1 賦值樣式、S2 matched_text、review I-1 PII 不洩漏、I-2 雙段 base64 不放過、I-3 snake_case 仍擋
tests/memory-secret-guard.test.js                                    — +4 case：S3 400 含 matched_text、S4 bot.example.com 全文 regression
package.json                                                         — version 1.19.12 → 1.19.13
README.md / docs/README.zh-TW.md / docs/README.ja.md                 — Current version → v1.19.13
CHANGELOG.md                                                         — v1.19.13 條目
```

---

## v1.19.12 修改（Code review 延後項收尾 + nginx 反向代理修正）

移動的檔（M-2）：
```
src/utils/secret-detect.js → shared/secret-detect.js          — 路徑統一到 shared/、所有 import 對應更新
```

修改的既有檔：
```
src/app.js                                                    — 加 app.set('trust proxy', 1)、修 express-rate-limit 警告
src/utils/memory-secret-guard.js                              — secret-detect import 路徑改 ../../shared/
hooks/ownmind-git-pre-commit.js                               — secret-detect import 路徑改 ../shared/
hooks/ownmind-reply-lint.js                                   — 合併 readLastAssistantText + readRecentUserPrompts 為 readTranscriptTail（I/O 減半）
shared/privacy-detect.js                                      — export PRIVACY_TYPE_LABELS（凍結物件、跟 PRIVACY_PATTERNS 並列）
tests/secret-detect-unit.test.js                              — import 路徑對應改 ../shared/
package.json                                                  — version 1.19.11 → 1.19.12
CHANGELOG.md                                                  — v1.19.12 條目
```

---

## v1.19.11 新增 / 修改（Lint UX 改善：誤判降低 + 雙顯示原因標註 + 自學資料根基）

新增檔：
```
hooks/lib/lint-event-logger.js                                — writeEvent 寫擋下事件、extractViolatedWords 抽違反詞統計（privacy 不存原值）；5MB cap rotate
tests/lint-event-logger.test.js                               — 12 case 純函式覆蓋
tests/reply-lint-hook-v1911.test.js                           — 7 case：分級訊息 + log 寫入整合
openspec/changes/archive/v1.19.11-lint-ux-improvements/proposal.md    — 提案：UX 改善三條 + 自學鋪路
openspec/changes/archive/v1.19.11-lint-ux-improvements/spec.md        — 14 個場景規格
openspec/changes/archive/v1.19.11-lint-ux-improvements/tasks.md       — 任務清單
```

修改的既有檔：
```
src/utils/memory-secret-guard.js                              — narrative 清單加 project / portfolio（誤判降低）
hooks/ownmind-reply-lint.js                                   — formatBlockReason 加分級顯示 + 標註要求；主流程整合 log 寫入
tests/memory-secret-guard.test.js                             — narrative 清單對齊 + 3 case 真實踩坑回歸
tests/reply-lint-hook-v197.test.js                            — 兩 case 改跑到第 1 次擋下（避開分級簡短訊息）
package.json                                                  — version 1.19.10 → 1.19.11
CHANGELOG.md                                                  — v1.19.11 條目
```

---

## v1.19.10 新增 / 修改（安全強化：預設密碼隨機化 + 設定檔最佳實踐）

新增檔：
```
shared/random-password.js                                     — 從 v1.19.9 generateTempPassword 抽出來、給多處共用（admin 建 user / seed job / reset-password）
openspec/changes/archive/v1.19.10-credential-hygiene/proposal.md      — 變更提案：預設密碼隨機化跟設定檔最佳實踐
openspec/changes/archive/v1.19.10-credential-hygiene/tasks.md         — 任務清單
```

修改的既有檔：
```
.mcp.json                                                     — OWNMIND_API_KEY 字面值改 __SET_VIA_LOCAL_CREDENTIALS_OR_ENV__ 佔位符、走本機憑證
src/routes/admin.js                                           — 移除固定預設密碼、改用 generateRandomPassword 每 user 隨機
src/jobs/seed-default-passwords.js                            — 同上、每筆 password_hash IS NULL 的 user 各別產隨機密碼、寫 log 一次性
src/routes/admin-password-reset.js                            — 改用 shared/random-password.js（generateTempPassword 為向後相容 alias）
src/utils/secret-detect.js                                    — 加 2 條 regex：ownmind_predefined_key + default_password_literal
tests/secret-detect-unit.test.js                              — 補 9 個 case 驗新樣式
.gitignore                                                    — 補 .mcp.local.json / credentials* / *.pem / .env.* / *.key 等
package.json                                                  — version 1.19.9 → 1.19.10
CHANGELOG.md                                                  — v1.19.10 條目
```

---

## v1.19.9 新增 / 修改（忘記密碼救援三條防線）

新增檔：
```
src/routes/admin-password-reset.js                            — POST /api/admin/users/:id/reset-password；factory pattern；generateTempPassword 純函式
scripts/reset-admin-password.js                               — CLI 救援腳本；互動式列 super_admin、雙重確認、產 SETUP_TOKEN、寫 audit log
tests/admin-reset-password.test.js                            — 16 case：權限規則 + 不能改自己 + 404 + 401 + audit log + bcrypt 端到端
tests/reset-admin-password-script.test.js                     — 4 case：腳本 smoke test（--help / DB 失敗）
openspec/changes/archive/v1.19.9-password-recovery/proposal.md        — 提案：三條防線設計 + 安全性分析
openspec/changes/archive/v1.19.9-password-recovery/spec.md            — 規格：15 個 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.19.9-password-recovery/tasks.md           — 任務清單
```

修改的既有檔：
```
src/app.js                                                    — 掛 /api/admin/users 的 admin-password-reset router（在 /api/admin 之前）
src/public/setup.html                                         — 成功頁加警告框：建議立即建第二位 admin
src/public/index.html                                         — 加 singleAdminBanner（admin+super_admin ≤ 1 時顯示）+ loadUsers() 計算邏輯
package.json                                                  — version 1.19.8 → 1.19.9
CHANGELOG.md                                                  — v1.19.9 條目
README.md / docs/README.zh-TW.md / docs/README.ja.md          — FAQ 新加「忘記密碼怎麼辦」段（位置在「首次安裝」段下方）
```

---

## v1.19.8 新增 / 修改（Setup Wizard：首次安裝零摩擦進後台）

新增檔：
```
src/routes/setup.js                                           — GET /api/setup/status + POST /api/setup/init；用 pg_advisory_xact_lock 鎖、Factory pattern 可注入
src/middleware/first-run-redirect.js                          — users 表為空 → /admin/* 自動 redirect 到 /setup；建好後反向 redirect 回登入頁
src/public/setup.html                                         — 純 HTML wizard：表單 + 成功頁顯示 api_key + 一鍵複製 + install.sh 範例
tests/setup-wizard.test.js                                    — 19 case：first-run 偵測 / 欄位驗證 / race condition / cache 行為 / fail-open
tests/first-run-redirect.test.js                              — 8 case：middleware 整合測試（code-review I-2 補的覆蓋缺口）
openspec/changes/archive/v1.19.8-setup-wizard/proposal.md             — 提案：chicken-and-egg 問題分析 + 解法選型（B+C 推薦、Codex Rescue 評估）
openspec/changes/archive/v1.19.8-setup-wizard/spec.md                 — 規格：16 個場景（GIVEN/WHEN/THEN）
openspec/changes/archive/v1.19.8-setup-wizard/tasks.md                — 任務清單
```

修改的既有檔：
```
src/app.js                                                    — 掛 first-run middleware + /api/setup route + GET /setup 靜態頁
src/utils/db.js                                               — 新增 withTransaction(fn) helper、給 transaction 序列化場景用
package.json                                                  — version 1.19.7 → 1.19.8
CHANGELOG.md                                                  — v1.19.8 條目
README.md / docs/README.zh-TW.md / docs/README.ja.md          — FAQ「首次安裝」段改寫：首推 wizard、SETUP_TOKEN 降為救援
```

---

## v1.19.7 新增 / 修改（IR-041 隱私偵測 + IR-002 密碼進 commit + reply-lint 切硬擋）

新增檔：
```
shared/privacy-detect.js                                      — 純函式 detectPrivacyLeak(text, { userPrompts })；身分證／信箱／台灣手機樣式 + user prompt 例外
tests/privacy-detect-unit.test.js                             — 25 case：身分證檢碼／信箱／手機／user prompt 例外／邊界／誤判防呆
tests/session-counter-block.test.js                           — 10 case：block_count 累加／讀取／清零、與 count 獨立、毀損檔回 0
tests/reply-lint-hook-v197.test.js                            — 7 case：連續擋 3 次降警告／通過時 reset／IR-041 整合與 user prompt 例外
tests/pre-commit-secret.test.js                               — 13 case：.env 擋／staged diff 含密鑰擋／OWNMIND_BYPASS 整合／邊界情境
```

修改的既有檔：
```
hooks/ownmind-reply-lint.js                                   — exit 2 + stderr reason／連續擋 3 次降警告 exit 1／加 IR-041 偵測整合
hooks/lib/session-counter.js                                  — schema 加 block_count／last_block_ts；新增 readBlockCount / incrementBlockCount / resetBlockCount
hooks/ownmind-git-pre-commit.js                               — 引入 parseBypass / logBypass；IR-002 加掃 staged diff 內容跑 detectSecretLike
tests/reply-lint-hook-v1193-block.test.js                     — 5 處：stdout JSON 斷言改 exit 2 + stderr 重寫指令斷言
CHANGELOG.md                                                  — v1.19.7 條目
package.json                                                  — version 1.19.6 → 1.19.7
```

---

## v1.19.6 新增 / 修改（Critical 鐵律卡控共用判定核心）

新增檔：
```
hooks/lib/rule-enforcer.js                                    — 純函式 enforceRule(ruleCode, context, options)、依 tier 決定 action（allow/block/warn/log_only/bypass）；包 shared/verification.js
hooks/lib/bypass-handler.js                                   — parseBypass + isBypassed + logBypass；OWNMIND_BYPASS 環境變數放行通道（含 ALL/All 大小寫 normalize）
tests/rule-enforcer-core.test.js                              — 18 case：fail-open / 三 tier 違反路徑 / bypass / catch path 真的 throw
tests/bypass-handler.test.js                                  — 15 case：parseBypass / isBypassed / logBypass / 大小寫變體
```

修改的既有檔：
```
shared/compliance.js                                          — schema 註解新增 block / bypass / hook_internal_error 三個合法 action
tests/compliance.test.js                                      — 補 3 case：新 action 三個值都能寫入 + 讀回
openspec/changes/archive/v1.19.20-iron-rule-enforcement-finishing/proposal.md
                                                                       — 重寫：反映 Gemini 對抗審查拍板（剔 IR-005/008/048）+ 漸進切法 v1.19.6~10
                                                                         （當時叫 v1.20-iron-rule-enforcement，v1.20 計畫拆成 v1.19.20~24 時改名）
openspec/changes/archive/v1.19.20-iron-rule-enforcement-finishing/tasks.md
                                                                       — 重寫：v1.19.6 範圍清單 + v1.19.7~10 後續預告
README.md / docs/README.zh-TW.md / docs/README.ja.md          — Iron Rule Enforcement Engine 段加 v1.19.6 兩條（rule-enforcer / bypass-handler）
CHANGELOG.md                                                  — v1.19.6 條目
package.json                                                  — version 1.19.5 → 1.19.6
```

---

## v1.19.5 新增 / 修改（修白名單 case-insensitive bug + 補漏字）

新增檔：
```
tests/language-lint-v1195.test.js                             — 29 case：case-insensitive 修復 + 22 個新加詞 + 真實踩坑回歸
```

修改的既有檔：
```
shared/language-lint.js                                       — 建構 TECH_WHITELIST_LOWER、查詢統一 lowercase；補 30+ 漏字（terminal / bump / Suspense / monad 等）
CHANGELOG.md                                                  — v1.19.5 條目
package.json                                                  — version 1.19.5
```

---

## v1.19.4 修改（Reply-lint 預設翻成 block）

修改的既有檔：

```
hooks/ownmind-reply-lint.js                                   — RAW_MODE 預設 'warn' → 'block'（IR-027 邏輯才有效、opt-in 等於沒落地）
tests/reply-lint-hook-v1193-block.test.js                     — 加 v1.19.4 預設 block suite 2 case + 更新場景 1 describe
README.md / docs/README.zh-TW.md / docs/README.ja.md          — Reply Lint 段更新預設行為說明
CHANGELOG.md                                                  — v1.19.4 條目
package.json                                                  — version 1.19.4
```

---

## v1.19.3 新增 / 修改（Reply-lint 漸進式 block + 白名單擴 200+ 詞）

新增檔：

```
hooks/lib/session-counter.js                                  — Claude session 違規累積計數純函式（讀 / 寫 / 自掃 30 天前）
tests/language-lint-v1193.test.js                             — 55 case：Top 30 詞、proper noun、threshold 分情境、code review 豁免、IR-036 視窗 80
tests/session-counter.test.js                                 — 10 case：純函式 + 防呆（檔不存在 / 毀損 / 自掃 / 無權限）
tests/reply-lint-hook-v1193-block.test.js                     — 8 case：MODE=warn / block / disable / 未知值、漸進累積、stop_hook_active、reason 指令型
openspec/changes/archive/v1.19.3-reply-lint-progressive-block/proposal.md   — 提案 + Codex 對抗審查結論
openspec/changes/archive/v1.19.3-reply-lint-progressive-block/spec.md       — 15 個 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.19.3-reply-lint-progressive-block/tasks.md      — 7 階段任務拆解（A-G）
```

修改的既有檔：

```
shared/language-lint.js                                       — TECH_WHITELIST 從 80 詞擴到 200+ 詞、加 proper noun 偵測、threshold 分情境、IR-036 視窗 50→80
hooks/ownmind-reply-lint.js                                   — 加 OWNMIND_REPLY_LINT_MODE env、漸進式 block 計數、block JSON stdout、formatBlockReason 指令型
README.md                                                     — Reply Lint Progressive Block 段
docs/README.zh-TW.md / docs/README.ja.md                      — 三語系同步（IR-032）
CHANGELOG.md                                                  — v1.19.3 條目
package.json                                                  — version 1.19.3
```

---

## v1.19.2 新增 / 修改（DB Migration 自動套用）

新增檔：

```
db/015_schema_migrations_table.sql                       — schema_migrations 追蹤表（filename PK / applied_at / applied_by）+ self-record
scripts/run-migrations.sh                                — CLI 版 migration runner（bash、docker exec ownmind-db 或直連 psql、INFO/OK/ERROR 輸出）
src/utils/run-migrations.js                              — Node 版 migration runner（在 src/index.js 啟動時自動跑、失敗 process.exit(1)）
tests/run-migrations.test.js                             — 22 case：SQL idempotent、bash 結構、Node migrator 行為、src/index.js 整合順序
openspec/changes/archive/v1.19.2-auto-migration/proposal.md      — 提案
openspec/changes/archive/v1.19.2-auto-migration/spec.md          — 10 個 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.19.2-auto-migration/tasks.md         — 7 階段任務拆解（A-G）
```

修改的既有檔：

```
src/index.js                                             — 改 async start()、await runMigrations() 後才 app.listen
README.md                                                — Tech Stack 加 DB Migrations 段
docs/README.zh-TW.md / docs/README.ja.md                 — 三語系同步（IR-032）
CHANGELOG.md                                             — v1.19.2 條目
package.json                                             — version 1.19.2
```

---

## v1.19.1 新增 / 修改（密碼 / Token 不寫進記憶、三層防護）

新增檔：

```
src/utils/secret-detect.js                               — detectSecretLike 純函式：5 regex + 英中 keyword + 長度啟發式 + skip_keyword 選項
src/utils/memory-secret-guard.js                         — validateMemoryContent 包一層、narrative 類型跳 keyword、bypass 回 lint_warning_entry
src/utils/memory-error-classifier.js                     — classifyMemoryError 把 catch-all 500 拆成 400/409/503/500（PG SQLSTATE 分流）
tests/secret-detect-unit.test.js                         — 26 case：5 regex、keyword、長度啟發式、bypass、邊界
tests/memory-secret-guard.test.js                        — 24 case：偵測、bypass、narrative 跳 keyword 但 regex 仍跑
tests/memory-error-classifier.test.js                    — 21 case：PG SQLSTATE / Node 連線 / JS 內建錯誤分類
tests/mcp-tool-description-secret-warning.test.js        — 10 case：source-level 驗證警語在前 80 字內
openspec/changes/archive/v1.19.1-secret-tool-routing/proposal.md — 提案
openspec/changes/archive/v1.19.1-secret-tool-routing/spec.md     — 13 個 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.19.1-secret-tool-routing/tasks.md    — 6 階段任務拆解（A-F）
```

修改的既有檔：

```
src/routes/memory.js                                     — POST/PUT 接 validateMemoryContent；catch-all 接 classifyMemoryError；4xx 用 warn 5xx 用 error
mcp/index.js                                             — ownmind_save / ownmind_update description 開頭加敏感資料警語、不動 inputSchema
README.md / docs/README.zh-TW.md / docs/README.ja.md     — 「Memory & Protection」段加「Memory vs Secret routing」條目
package.json / docs/README*                              — 1.19.0 → 1.19.1
CHANGELOG.md                                             — v1.19.1 條目
```

OwnMind iron_rule 新增（透過 ownmind_save、不在 repo）：

```
IR-047                                                   — 敏感資料一律走密鑰管理工具、不寫進記憶／對話／程式碼提交
                                                          tier=critical、related_rules=[IR-002, IR-041]
                                                          5 個 trigger tags（credential/password/secret/api_key/token）
```

---

## v1.19.0 新增 / 修改（鐵律分級 Critical / Default / Advisory）

新增檔：

```
db/014_iron_rule_tier.sql                                — memories 加 tier 欄位 + CHECK + 部分索引
shared/iron-rule-tier.js                                 — tier 常數 / validation / emoji / 排序 / 分桶純函式
src/utils/iron-rule-tier-validator.js                    — server route 用的請求驗證 + 寫入兜底
src/utils/iron-rule-digest.js                            — buildIronRulesDigest（分組顯示）+ countByTier
hooks/lib/build-compliance-events.js                     — reply-lint violation event 組裝（details.tier）
tests/iron-rule-tier-helper.test.js                      — 21 條 helper 測試
tests/iron-rule-tier-validator.test.js                   — 10 條 validator 測試
tests/iron-rule-tier-digest.test.js                      — 12 條 digest 測試
tests/iron-rule-tier-mcp.test.js                         — 7 條 MCP source-level 測試
tests/build-compliance-events.test.js                    — 9 條 compliance event 測試
openspec/changes/archive/v1.19-iron-rule-tier/proposal.md        — 提案
openspec/changes/archive/v1.19-iron-rule-tier/spec.md            — 12 個 GIVEN/WHEN/THEN 場景
openspec/changes/archive/v1.19-iron-rule-tier/tasks.md           — 任務拆解
```

修改的既有檔：

```
src/routes/memory.js                                     — POST/PUT 接 tier; /init 回 iron_rules_tier_counts; digest 改用 buildIronRulesDigest
src/routes/admin-iron-rule-upgrade.js                    — /upgrade-status 回 tier 欄位
mcp/index.js                                             — ownmind_save / ownmind_update schema 加 tier; case handler 把 args.tier 傳到 body
hooks/lib/render-session-context.js                      — 鐵律段標題加 tier 分佈 summary（舊 server fallback）
hooks/ownmind-reply-lint.js                              — dynamic import getTierFromRules + buildComplianceEvents
hooks/ownmind-git-post-commit.js                         — appendCompliance 加 tier 欄位
shared/compliance.js                                     — appendCompliance 接 entry.tier（用 isValidTier 過濾）
tests/compliance.test.js                                 — 加 3 條 v1.19 tier 測試
tests/session-start-render.test.js                       — 加 3 條 v1.19 tier 分佈 summary 測試
src/public/index.html                                    — 鐵律升級助手列表加 Tier 欄 + dropdown（inline 編輯 PUT /memory/:id）
package.json / README* / docs/README*                    — 1.18.9 → 1.19.0
CHANGELOG.md                                             — v1.19.0 條目
```

---

```
OwnMind/
├── README.md                        # 專案說明、應用情境、安裝 prompt
├── FILELIST.md                      # 本檔案 — 檔案結構說明
├── CHANGELOG.md                     # 版本更新紀錄
├── .env.example                     # 環境變數範本
├── .gitattributes                   # 強制 hook / shell scripts 用 LF 行尾（防 Windows core.autocrlf 把 sh script 轉 CRLF 導致 Exec format error）
├── .gitignore                       # Git 忽略規則
├── Dockerfile                       # API Server Docker image
├── docker-compose.yml               # Docker Compose 部署設定
├── install.sh                       # 一鍵安裝腳本（Mac / Linux / Git Bash）
├── install.ps1                      # 一鍵安裝腳本（Windows PowerShell 原生）
├── package.json                     # API Server 依賴
│
├── db/
│   ├── 001_init.sql                 # PostgreSQL schema（users, memories, handoffs 等 6 張表）
│   ├── 002_add_team_standard.sql    # 團隊規範相關 migration
│   ├── 003_activity_logs.sql        # Activity logs 表（事件追蹤）
│   ├── 004_weekly_summary_marker.sql # users.weekly_summary_sent_at（週摘要 marker）
│   ├── 005_admin_roles_password.sql  # password_hash、super_admin 角色、audit_logs 表
│   ├── 006_add_standard_detail.sql   # memories type 加上 standard_detail
│   ├── 007_token_usage.sql           # Token 用量追蹤 7 張表 + 初始 model pricing
│   ├── 008_broadcast.sql             # v1.17.0 — broadcast_messages / user_broadcast_state / user_tool_last_seen / memories.is_test
│   ├── …                             # 009-017 見各版本變更清單；這棵樹自 008 起未同步
│   ├── 018_collector_heartbeat_reason.sql # v1.26.69 — collector_heartbeat.reason（收集器為什麼沒東西；
│   │                                 #   不重用 status，上一層 API 已有同名但不同義的欄位）
│   └── 019_collector_heartbeat_per_machine.sql # v1.26.73 — 心跳的鍵改成 (user_id, tool, machine)。
│                                     #   machine 先補值再設 NOT NULL（Postgres 認為兩個 NULL 互不相同，
│                                     #   留 NULL 會讓不報主機名的客戶端每次心跳都插新列）；先建新索引
│                                     #   再拆舊約束，撞號時整筆交易失敗、不會留下沒有唯一性的表
│
├── src/                             # API Server 原始碼
│   ├── app.js                       # Express app 設定、路由掛載
│   ├── constants.js                 # 共用常數（ALLOWED_MEMORY_TYPES）
│   ├── index.js                     # Server 啟動入口
│   ├── middleware/
│   │   ├── auth.js                  # API Key 認證中介層
│   │   └── adminAuth.js             # Admin 權限中介層（含 superAdminAuth + isAtLeast）
│   ├── routes/
│   │   ├── memory.js                # 記憶 CRUD + init（含 instructions SOP）
│   │   ├── session.js               # Session log 紀錄
│   │   ├── handoff.js               # 交接機制
│   │   ├── admin.js                 # 使用者管理 + 帳密登入 + 角色控管 + 稽核
│   │   ├── secret.js                # 密鑰管理（AES-256 加密；v1.17.91 POST 改 upsert + 寫 activity_log audit）
│   │   ├── export.js                # 記憶匯出
│   │   ├── activity.js              # Activity log batch upload + 統計 API
│   │   └── usage/                   # Token 用量追蹤 API（P1 起）
│   │       ├── index.js             # 掛載 /api/usage/* 子路由
│   │       ├── pricing.js           # GET 所有 model pricing；POST 新增（super_admin only, append-only）
│   │       ├── events.js            # POST raw events（exempt check / codex fingerprint / heartbeat / D7 / dedupe / trigger aggregation）
│   │       ├── stats.js             # GET 個人 stats（from / to / group_by=day|tool|model|session）
│   │       ├── self-check.js        # v1.26.72 — GET 伺服器手上有這個帳號的哪些收集器紀錄（含 server_time
│   │                                #   讓 client 不用自己的時鐘判斷新鮮度）。一般成員可用、只看得到自己，
│   │                                #   不吃任何 user 參數、不 join users 表
│   │       ├── exemptions.js        # GET / POST / DELETE usage_tracking_exemption（super_admin only）
│   │       ├── admin-audit.js       # GET usage_audit_log（admin+；可 filter event_type / user_id）
│   │       ├── admin-clients.js     # v1.17.0 — GET 裝機狀況（admin+；per user+tool heartbeat + needs_upgrade + coverage）
│   │       └── team-stats.js        # GET 團隊 coverage + 逐 user 總計（admin+，spec D5）
│   │   └── broadcast.js             # v1.17.0 P2 — 廣播系統（admin CRUD + user active/dismiss + snooze）
│   ├── lib/
│   │   ├── broadcast-filter.js      # v1.17.0 P2 — filterVisibleBroadcasts / filterInjectable（P2 + P4 共用）
│   │   ├── memory-sync.js           # v1.17.8 — delta sync 純函式（parseSyncTypes / parseSince / buildSyncQuery）
│   │   └── session-query.js         # v1.17.13 — buildSessionRecentQuery 純函式（含 ?q= search）
│   ├── utils/
│   │   ├── db.js                    # PostgreSQL 連線池
│   │   ├── logger.js                # Winston logger
│   │   ├── crypto.js                # AES-256 加解密工具
│   │   ├── syncToken.js             # Sync token 生成與驗證（SHA-256）
│   │   ├── report.js               # 週/月報計算純函式（computePeriodRange, groupFrictions）
│   │   ├── enforcement.js          # Enforcement alerts 計算純函式
│   │   ├── templates.js            # 規則模板庫 + 自動匹配
│   │   ├── auto-numbering.js       # Iron rule 自動編號（generateNextIronRuleCode）
│   │   ├── pricing-lookup.js       # Token 定價查找（pickPricing / computeCost / lookupPricing）
│   │   ├── semver.js               # v1.17.0 — parseSemver / compareSemver / isLower / isHigher（version 比對共用）
│   │   ├── enrich-activity.js      # v1.17.89 + v1.17.90 — activity_log 落 DB 前 enrich：所有 disable/update 自動 snapshot disabled_type；iron_rule 額外 snapshot disabled_code+disabled_title
│   │   └── iron-rule-quality.js    # v1.17.94 — 鐵律品質 lint（trigger tag / 適用情境 / 規則段落 / 字數 / 中英混雜 / context 依賴詞），server POST/PUT iron_rule 強制檢查
│
├── shared/                          # 跨 server + client + hook 共用 lib
│   └── language-lint.js            # v1.17.95 — IR-037 中英混雜 + IR-036 行話檢查的純函式（給 iron-rule lint + Stop hook reply-lint 共用）
│   ├── jobs/
│   │   ├── weeklyReport.js          # 週/月報 cron job（node-cron）
│   │   ├── usage-aggregation.js     # token_events → token_usage_daily 重算（純函式 + recomputeDaily）
│   │   ├── nightly-recompute.js     # 每日 03:00 Asia/Taipei 跑近 7 天完整 recompute
│   │   └── nightly-upgrade-reminder.js  # v1.17.0 P2 — 每日 03:30 冪等產生 upgrade_reminder 廣播
│   └── public/
│       └── index.html               # Admin 管理後台（單頁應用）
│
├── mcp/                             # MCP Server（供 Claude Code、Cursor 等工具使用）
│   ├── index.js                     # MCP Server 入口（13 個 tools）+ 啟動時自動更新
│   ├── offline.js                   # Offline resilience helpers（local cache read/write, write queue, local search）
│   ├── ownmind-log.js               # Activity log 模組（本地 JSONL + server batch upload）
│   ├── start.cmd                    # Windows 啟動器（動態找 node，供 cmd.exe 呼叫）
│   └── package.json                 # MCP Server 依賴
│
├── shared/
│   ├── verification.js              # Verification Engine 核心（純函式）
│   ├── helpers.js                   # 共用工具函式（readJsonSafe、getChangedSourceFiles、readCredentials、trigger detection）
│   ├── compliance.js                # 統一 compliance log schema 讀寫
│   └── scanners/
│       ├── id-helper.js             # Codex 專用 fingerprint（canonicalize + sha256 message_id；client+server 共用）
│       ├── base.js                  # Scanner orchestrator：runScan / atomic offsets / batching（P4）
│       ├── claude-code.js           # Claude Code JSONL adapter（session cumulative running total、byte_offset cursor）
│       ├── codex.js                 # Codex JSONL adapter（event_msg/token_count → canonical material → message_id）
│       ├── opencode.js              # OpenCode SQLite adapter（sqlite3 CLI、composite (time_created, id) cursor）
│       ├── sqlite-cli.js            # v1.26.71 — 所有 sqlite3 CLI 查詢的唯一入口。別人的檔案一律只用 -readonly 開；
│                                    #   開不起來（應用程式沒開著）才連 -wal/-shm/-journal 一起複製到暫存目錄、
│                                    #   不帶任何參數開複本讓 SQLite 重播 WAL，讀完刪掉。另含 databaseExists
│                                    #   （分辨「讀不到」跟「根本沒裝」，只有 ENOENT 算沒裝）
│       ├── vscode-telemetry.js      # Cursor/Antigravity 共用 helper（state.vscdb 讀取 + Taipei Ymd + 通用 adapter 工廠）
│       ├── cursor.js                # Cursor Tier 2 adapter（session_count only）
│       ├── antigravity.js           # Antigravity Tier 2 adapter（session_count only）
│       ├── reasons.js               # v1.26.69 — 收集器「為什麼沒東西」的封閉原因碼（ok / no_new_activity /
│                                    #   no_install / sqlite_missing / unreadable / account_changed）
│       ├── selfcheck.js            # v1.26.72（v1.26.73 起會在同一個工具的多台機器裡挑自己那台） — 「我送了」跟「伺服器真的有」是兩件事。比對本機掃描結果
│                                    #   跟伺服器回報，產出 confirmed / not_installed / other_machine /
│                                    #   not_recorded / blocked 五種判定 + 給人看的說明
│       └── gemini-conversations.js  # v1.26.68 — Antigravity 三個介面的對話檔日期來源（管理器/編輯器/命令列，
│                                    #   ~/.gemini/<介面>/conversations 只讀 mtime 不開內容、介面名單寫死不用萬用字元）
│
├── hooks/                           # Claude Code hook scripts（安裝時複製到 ~/.claude/hooks/）
│   ├── package.json                 # ESM module declaration（type: module）
│   ├── ownmind-session-start.sh    # SessionStart hook：自動載入記憶 + 每日自動更新（bash 版）
│   ├── ownmind-session-start.js    # SessionStart hook（L4）：ESM，載入初始記憶並顯示鐵律摘要
│   ├── ownmind-iron-rule-check.sh  # PreToolUse hook：高風險指令前自動顯示相關鐵律（bash 版）
│   ├── ownmind-iron-rule-check.js  # PreToolUse hook（L2）：ESM，commit/deploy/delete 都跑 verification blocking
│   ├── ownmind-tty-echo.cjs        # v1.17.71 — PostToolUse hook：把【OwnMind】banner 寫到 user terminal（繞過 Claude Code UI）
│   ├── ownmind-reply-lint.js       # v1.17.96 — Stop hook：每輪 AI 回話結束跑 IR-037/IR-036 lint、違反印 banner + 報 violate
│   ├── ownmind-worktree-setup.sh   # WorktreeCreate hook：worktree 自動注入 .mcp.json
│   ├── ownmind-git-pre-commit.js   # git pre-commit hook (L1)
│   ├── ownmind-git-post-commit.js  # git post-commit hook (L5)
│   ├── ownmind-git-pre-commit      # pre-commit shell wrapper
│   ├── ownmind-git-post-commit     # post-commit shell wrapper
│   ├── ownmind-git-commit-msg      # commit-msg shell wrapper（IR-024 阻擋 Co-Authored-By）
│   ├── ownmind-verify-trigger.js   # deploy/delete 驗證輔助腳本
│   ├── ownmind-usage-scanner.js    # Token 用量 scanner 主 entry（P4；P6 由 launchd/systemd 每 30 分鐘呼叫）
│   ├── ownmind-selfcheck.js        # v1.26.72 — 跑一次掃描、再回頭問伺服器有沒有收到，印人看得懂的結果。
│                                    #   安裝/升級結束時自動跑，也可以手動跑來診斷單一台機器。
│                                    #   絕不會弄壞安裝（網路問題一律 exit 0），但真的沒送到會 exit 1
│   └── lib/                        # v1.17.0 P3 — hook 共用純函式
│       ├── render-session-context.js   # renderSessionContext(data, broadcasts) → additionalContext 字串
│       ├── session-start-output.js     # Node CLI wrapper，讓 bash hook 呼叫
│       ├── sync-memory-files.js        # v1.17.8 — 雲端 → 本地 md 檔 delta sync（stdin JSON / --fail mode）；v1.26.100 MEMORY.md 加 140 行預算 + 按需分配 + 溢位說明；v1.26.101 鐵律固定只佔 20 行、其餘給專案
│       └── flush-compliance-spool.js   # v1.17.97 — SessionStart 補送 reply-lint-pending.jsonl 到 /api/activity/batch（POST 200 後刪檔）
│
├── scripts/                         # 維護工具腳本
│   ├── bootstrap.sh                 # v1.17.6 — Universal Bootstrap（Mac/Linux/Git Bash）：三分支處理 install/upgrade/repair
│   ├── bootstrap.ps1                # v1.17.6 — Universal Bootstrap（Windows PowerShell）：同上
│   ├── update.sh                    # Auto-update：同步 skill、hooks、settings 到所有 AI 工具
│   ├── check-sync.sh                # v1.17.2 — 三層 drift 健檢（L1 git / L2 server version / L3 deploy diff）
│   ├── migrate-verification.js      # 鐵律 verification 一次性遷移
│   ├── install-helpers/
│   │   ├── add-post-tool-use-hook.cjs  # v1.17.71 — 把 ownmind-tty-echo PostToolUse hook idempotent 寫入 settings.json
│   │   ├── add-stop-hook.cjs           # v1.17.96 — 把 ownmind-reply-lint Stop hook idempotent 寫入 settings.json
│   │   ├── dep-floor.mjs               # v1.26.41 — root 相依版本門檻比對純函式庫（讀不出來一律當未達門檻）
│   │   ├── dep-floor-cli.mjs           # v1.26.41 — 上面那支的 shell 判斷式（update.sh / update.ps1 共用）
│   │   └── run-scanner.sh           # Usage scanner wrapper：動態找 node + v20+ 驗證（D12）
│   ├── launchd/
│   │   └── com.ownmind.usage-scanner.plist  # macOS launchd agent（30 分鐘 + RunAtLoad）
│   ├── systemd/
│   │   ├── ownmind-usage-scanner.service    # Linux user service（oneshot）
│   │   └── ownmind-usage-scanner.timer      # Linux user timer（開機 5 分鐘 + 每 30 分鐘）
│   └── windows/
│       └── register-scanner-task.ps1        # Windows Task Scheduler 註冊腳本
│
├── configs/                         # 各工具的全域強制規則（安裝時複製到對應位置）
│   ├── CLAUDE.md                    # Claude Code → ~/.claude/CLAUDE.md
│   ├── AGENTS.md                    # Codex → ~/.codex/AGENTS.md
│   ├── GEMINI.md                    # Gemini CLI → ~/.gemini/GEMINI.md
│   ├── global_rules.md              # Windsurf → ~/.codeium/windsurf/memories/global_rules.md
│   ├── opencode.json                # OpenCode → ~/.config/opencode/opencode.json
│   ├── antigravity.md               # Google Antigravity → 全域指令設定
│   ├── copilot-instructions.md      # GitHub Copilot → .github/copilot-instructions.md
│   ├── openclaw.json                # OpenClaw → 合併到 ~/.openclaw/openclaw.json
│   └── openclaw-bootstrap.md       # OpenClaw bootstrap 注入檔（OwnMind 強制規則）
│
├── skills/
│   └── ownmind-memory.md            # OwnMind 記憶管理 Skill
│
├── tests/
│   ├── report.test.js               # report.js 單元測試（node:test）
│   ├── enforcement.test.js          # enforcement.js 單元測試
│   ├── verification.test.js         # Verification Engine 測試
│   ├── templates.test.js            # 模板匹配測試
│   ├── helpers.test.js              # shared/helpers.js 單元測試
│   ├── compliance.test.js           # shared/compliance.js 單元測試
│   ├── trigger-detection.test.js    # 觸發檢測精準度測試
│   ├── pricing.test.js              # pricing-lookup.js 單元測試（effective_date / cost 計算）
│   ├── aggregation.test.js          # usage-aggregation.js 單元 + recomputeDaily integration
│   ├── ingestion.test.js            # events.js validation / dedupe / audit / codex / heartbeat / exempt
│   ├── fingerprint.test.js          # shared/scanners/id-helper.js（canonicalize + sha256 deterministic）
│   ├── exemptions.test.js           # exemptions route CRUD + audit
│   ├── scanner-base.test.js         # base.js：chunk / mergeState / atomic offsets / runScan
│   ├── scanner-claude-code.test.js  # claude-code adapter：fixture parse / cumulative / crash-resume / replay safety
│   ├── scanner-lock.test.js         # acquireLock：live PID / stale PID / 6h mtime 接手
│   ├── scanner-codex.test.js        # codex adapter：token_count → material → message_id / compact / byte_offset cursor
│   ├── scanner-opencode.test.js     # opencode adapter：composite cursor / interleaved sessions / SQL escape
│   ├── run-scanner-wrapper.test.js  # wrapper shell script：候選選擇 / version 檢查 / error 路徑（spawn bash）
│   ├── scanner-cursor-antigravity.test.js  # Tier 2 adapter（state.vscdb + Taipei Ymd + session record emit 規則）
│   ├── team-stats.test.js           # /api/usage/team-stats coverage + users aggregate + 角色驗證
│   ├── stats.test.js                # /api/usage/stats totals / series / Tier-2 merge / null-cost policy
│   ├── clients.test.js              # v1.17.0 — /api/usage/admin/clients（auth / status / upgrade / multi-tool / coverage / pre-release）
│   ├── semver.test.js               # v1.17.0 — parseSemver / compareSemver（pre-release / build metadata / malformed）
│   ├── broadcast.test.js            # v1.17.0 P2 — validate / CRUD / snooze / filter / cooldown / nightly job（46 tests）
│   ├── session-start-render.test.js # v1.17.0 P3 — renderSessionContext（broadcasts + memory）
│   ├── mcp-startup-heartbeat.test.js # MCP 啟動時自動觸發 heartbeat 的靜態檢查（v1.17.4）
│   ├── heartbeat-once-per-process.test.js # Heartbeat 每個 MCP process 最多發一次（client 端 crash-loop 保護，v1.17.5）
│   ├── heartbeat-rate-limit.test.js  # Heartbeat UPSERT 30 秒內為 no-op（server 端 rate-limit，v1.17.5）
│   ├── bootstrap-script.test.js     # Universal bootstrap 腳本靜態檢查（三分支 / +x bit / logging / curl-pipe 安全，v1.17.6）
│   ├── bootstrap-routes.test.js     # Express public routes 整合測試（GET /bootstrap.sh / .ps1 無 auth 正常回應，v1.17.6）
│   ├── tip-every-call.test.js       # MCP 技巧提示每次都顯示（移除 tipCallCount % 10 gating，v1.17.7）
│   ├── memory-sync-endpoint.test.js # v1.17.8 — /api/memory/sync 參數解析 + SQL builder（16 tests）
│   ├── sync-memory-files.test.js    # v1.17.8 — 本地 md 同步 / tombstone / fail mode / backup；v1.26.100 索引行數預算 + 溢位說明 + 排序；v1.26.101 鐵律額度上限（52 tests）
│   ├── ps1-utf8-bom.test.js         # v1.17.9 — 所有 .ps1 必須 UTF-8 BOM（Alice case）
│   ├── ps1-windows-compat.test.js   # v1.17.9 — .ps1 環境正規化 preamble + install flag 過濾（Bob case）
│   ├── install-ps1-copy-safety.test.js  # v1.17.10 — install.ps1 Copy-Item self-overwrite guard
│   ├── install-scanner-module-list.test.js # v1.26.71 — install.sh 不准手寫 scanner 檔名清單
│                                    #   （寫死五個、實際十一個，三個半月沒人發現；那段複製其實是
│                                    #   死碼，來源=目的地會被 safe_cp 跳過，檔案是 git clone 帶的）
│   ├── scheduled-task-duration.test.js  # v1.17.10 — Task Scheduler Duration 不能用 TimeSpan.MaxValue
│   ├── bootstrap-strip-bom.test.js  # v1.17.10 — bootstrap public route strip BOM（iwr|iex 相容）
│   ├── credentials-bom-safe.test.js # v1.17.12 — readCredentials / readJsonSafe 容忍 BOM-prefixed JSON
│   ├── install-ps1-no-bom-outputs.test.js # v1.17.12 — install.ps1 禁用 Set-Content 寫敏感檔
│   ├── install-ps1-scanner-task-check.test.js # v1.17.12 — install.ps1 驗證 scanner task 真的註冊
│   ├── scanner-task-durability.test.js # v1.26.65 — 排程不可先刪再建 / 註冊後回查 / VBS 回傳真 exit code / 升級失敗要響 / 缺金鑰非 0 退出
│   ├── scanner-blind-scan.test.js   # v1.26.65 —「讀不到目錄」不得回報成「沒有檔案」；單一檔案讀不到只跳過該檔、心跳照送；readSince 回報 scanned / skipped
│   ├── scanner-vscode-multipath.test.js # v1.26.66 — Antigravity 改資料夾名後要讀到新的那個；多候選挑最新、只有 ENOENT 算沒安裝、未來日期不得毒化游標、掃描紀錄要印 sessions=N
│   ├── mcp-client-tool-attribution.test.js # v1.26.67 — 「跑在哪個工具裡」只能有一份規則；OWNMIND_TOOL 優先、空字串視同未設、四個呼叫點不得各自實作
│   ├── sqlite-readonly-fallback.test.js # v1.26.70 — 編輯器關著時 state.vscdb 讀不到；複本要連 -wal 一起帶、複本不帶參數開、原檔只用 -readonly、暫存一定刪掉
│   ├── collector-silence-reason.test.js # v1.26.69 — silent 要說出原因；六個原因碼封閉、換帳號丟掉「這天報過了」但保留讀取位置、舊版收集器不猜
│   ├── scanner-antigravity-conversations.test.js # v1.26.68 — 非 VSCode 介面的用量要看得到；三個介面名單不含 backup、只讀 mtime 不開內容、未來日期逐檔擋、遙測較新時不得倒退
│   ├── scanner-opencode-closed.test.js # v1.26.71 — OpenCode 自己的資料庫也是 WAL；-readonly 開不起來要退回複本，
│                                    #   複本要連 -wal / -shm 一起帶；含一條真的跑 sqlite3 CLI、先驗證前提再驗證結論
│   ├── selfcheck-report.test.js     # v1.26.72 — 本機掃到的跟伺服器手上有的比對成五種結論；
│                                    #   機器名未知不算「別台」、同一工具多台時挑自己那台（v1.26.73）
│   ├── selfcheck-endpoint.test.js   # v1.26.72 — GET /api/usage/self-check 只回自己的列、不 join users、順序固定
│   ├── selfcheck-entry.test.js      # v1.26.72 — 獨立入口；查不到就當沒查（exit 0），真的沒送到才 exit 1；金鑰遮蔽
│   ├── self-check-usage-roundtrip.test.js # v1.26.72 — 安裝後自我檢查的第九項：不信 POST 自己的回應，回頭跟伺服器對帳
│   ├── heartbeat-per-machine.test.js # v1.26.73 — 一台電腦一列；machine 進鍵值、更新時不得改寫它、
│                                    #   每個 (人, 工具) 最多 20 台（客戶端字串進了鍵值就是新的攻擊面）
│   ├── machine-groups.test.js       # v1.26.73 — 系統設定頁依電腦分組；狀態取最糟的工具、心跳取最新、壞的排前面
│   ├── install-prerequisite-auto-install.test.js # v1.17.76 — 缺 node/git 時 install.ps1/sh 自動安裝（vin-windows-test 回報 7 條 contract test）
│   ├── start-cmd-node-fallback.test.js     # v1.17.77 — start.cmd 多層 node fallback + install.ps1 寫 User PATH（vin-windows-test 第二輪 5 條）
│   ├── install-started-beacon.test.js     # v1.17.78 — install_started beacon + 接受 minimal payload（IR-038 觀測管道補洞 7 條）
│   ├── error-spool-mechanism.test.js       # v1.17.79 — errors/ spool 統一錯誤回報 + dirty tree auto-recover（IR-038 廣域觀測管道 15 條）
│   ├── install-beacon-spool-fallback.test.js # v1.17.80 — install_started beacon 失敗 spool fallback（vin-windows-test 第四輪 4 條）
│   ├── update-script-observability.test.js  # v1.17.81 — update.ps1 heredoc StackOverflow fix + beacon/report-error wiring（vin-windows-test 第五輪 8 條）
│   ├── install-check-null-byte-sanitize.test.js # v1.17.83 — server JSONB null byte sanitize（vin-windows-test 第六輪 5xx 風暴 4 條）
│   ├── spool-retry-cap.test.js              # v1.17.83 — retrySpool 達 MAX 後 drop 避免無限重送（3 條）
│   ├── upgrade-windows-file-lock.test.js    # v1.17.84 — Windows file-lock 偵測 + check-sync.sh L2 grep fallback（vin-windows-test 第七輪 7 條）
│   ├── install-failed-beacon.test.js        # v1.17.85 — interactive-upgrade FAIL 函式統一補 fallback report_error（IR-038 觀測盲點補強 3 條）
│   ├── debug-route-beacon-version.test.js   # v1.17.85 — debug.js beacon trigger client_version 強制 NULL，admin query 不再被 sentinel 污染（6 條）
│   ├── upgrade-complete-beacon.test.js      # v1.17.86 — upgrade_complete beacon + SessionStart drain spool（IR-038 兩 source 對不上修補 + IR-007 同類雷收尾 7 條）
│   ├── me-pitfalls.test.js                  # v1.17.87 — /api/me/pitfalls 跨 user 踩坑紀錄 endpoint + me.js sensitive event 拿掉 handoff_create + memory.js save/disable 補 server compliance log + me.html 踩坑 tab UI（17 條）
│   ├── me-trailing-slash.test.js            # v1.17.88 — /me 沒尾斜線 301 redirect 到 me/（相對路徑避開 nginx prefix 問題、條件式避開 strict routing=false 無限循環）（3 條）
│   ├── session-recent-query.test.js # v1.17.13 — buildSessionRecentQuery 含 q= search 支援
│   ├── tier2-windows-fix.test.js    # v1.17.14 — Tier 2 Windows 支援（opencode win32 + sqlite3 偵測）
│   ├── p3-update-event-semantics.test.js # v1.17.16 — update_ok 假陽性 fix（Bob case；mcp/index.js + hook 對偶；11 tests）
│   ├── team-overview-api.test.js         # v1.17.17 — 鐵律遵守率算法、票選專案、scoreboard endpoint（16 cases）
│   └── team-overview-sessions-api.test.js # v1.17.17 — sessions endpoint、machine_meta fallback、limit 邊界（7 cases）
│
└── docs/                            # 文件 + 多語系 README
    ├── README.zh-TW.md              # 繁體中文 README
    ├── README.ja.md                 # 日文 README
    ├── setup-claude-code.md
    ├── setup-codex.md
    ├── setup-cursor.md
    ├── setup-copilot.md
    ├── setup-online-ai.md
    └── superpowers/
        ├── plans/
        │   ├── 2026-04-23-mcp-startup-heartbeat.md  # v1.17.4 MCP 啟動 heartbeat 實作計畫
        │   └── 2026-04-28-dashboard-team-overview.md  # v1.17.17 Dashboard 團隊一覽改造計畫
        └── specs/
            └── 2026-04-28-dashboard-team-overview-design.md  # v1.17.17 Dashboard 團隊一覽設計 spec
```

## v1.17.17 新增 / 修改

新增檔案：

```
src/routes/usage/team-overview.js         — 團隊一覽 admin API（scoreboard + sessions timeline）
db/009_collector_heartbeat_os.sql         — collector_heartbeat 加 os 欄位 migration
tests/team-overview-api.test.js           — 團隊一覽 scoreboard 單元測試（16 cases）
tests/team-overview-sessions-api.test.js  — 團隊一覽 sessions 單元測試（7 cases）
docs/superpowers/specs/2026-04-28-dashboard-team-overview-design.md
docs/superpowers/plans/2026-04-28-dashboard-team-overview.md
```

修改的既有檔：

```
src/routes/usage/events.js   — heartbeat UPSERT 補 os 欄位
src/routes/usage/index.js    — mount team-overview router
mcp/index.js                 — heartbeat 加 os: os.platform()
src/public/index.html        — 表格擴欄 / 最近對話區 / Audit Log 改名為「資料品質警示」
```

## v1.17.18 修改（broadcast-version-filter handoff）

修改的既有檔：

```
hooks/ownmind-session-start.sh        — 呼叫 /broadcast/active 時帶 client_version + X-Ownmind-Version
mcp/index.js                          — fetchBroadcastsSafely 改用 CLIENT_VERSION（不再依賴未設定的 env var）
scripts/interactive-upgrade.sh        — OK:done 之前自動 dismiss type=upgrade_reminder 廣播
scripts/interactive-upgrade.ps1       — 同上，PowerShell 版
skills/ownmind-upgrade.md             — 移除「Step 3：AI 手動 dismiss」段落，改成「腳本自動處理」
tests/broadcast.test.js               — 新增 2 個 /broadcast/active route 的 client_version regression case
package.json / docs/README*           — 1.17.17 → 1.17.18，三語系同步
CHANGELOG.md                          — v1.17.18 條目
```

## v1.17.19 修改（project_281 backlog item C — LOCK_FILE touch fail handling）

修改的既有檔：

```
mcp/index.js                              — touch "${LOCK_FILE}" 加 || echo __OM_LOCK_FAIL__ + failMarkers 補入
hooks/ownmind-session-start.sh            — touch "$LOCK_FILE" 加 || log_event update_failed step=lock
tests/p3-update-event-semantics.test.js   — 新增 3 個 P3-lock regression case
package.json / docs/README*               — 1.17.18 → 1.17.19，三語系同步
CHANGELOG.md                              — v1.17.19 條目
```

## v1.17.20 新增 / 修改（admin 工作紀錄頁）

新增檔：

```
src/routes/admin-work-log.js              — GET /api/admin/work-log + /filters，三來源 UNION ALL
tests/admin-work-log.test.js              — 9 case 涵蓋權限/SQL/篩選/limit cap/total
```

修改既有：

```
src/app.js                                — mount /api/admin/work-log（在 /api/admin 之前）
src/public/index.html                     — 新「工作紀錄」tab + JS loader；資料品質警示 card 加 hidden
package.json / docs/README*               — 1.17.19 → 1.17.20，三語系同步
CHANGELOG.md                              — v1.17.20 條目
```

## v1.17.21 修改（compact mode 砍掉合規回報指令的回灌）

新增檔：

```
tests/init-compact-compliance-instruction.test.js  — 3 case 防退化
```

修改既有：

```
src/routes/memory.js                         — ironRulesDigestFinal 末尾固定加合規回報指令
package.json / docs/README*                  — 1.17.20 → 1.17.21，三語系同步
CHANGELOG.md                                 — v1.17.21 條目
```

## v1.17.22 新增 / 修改（Windows MCP auto-update silent-skip 修補）

新增檔：

```
scripts/update.ps1                                — update.sh 的 PowerShell 版（含 UTF-8 BOM）
tests/mcp-auto-update-cross-platform.test.js      — 8 case 跨平台 reproduction
```

修改既有：

```
mcp/index.js                              — 整段 auto-update 重構：os.homedir() + Node-native execFile
                                            + update_skipped 觀測 event
tests/p3-update-event-semantics.test.js   — 既有 P3 / P3-lock 測試對齊 Node-native 新架構
package.json / docs/README*               — 1.17.21 → 1.17.22，三語系同步
CHANGELOG.md                              — v1.17.22 條目
```

## v1.17.23 修改（Codex review 後續修補 5 項）

修改既有：

```
mcp/index.js                              — atomic lock (openSync wx) + git pull --autostash
                                            + 外層 catch log update_failed step=outer
scripts/update.ps1                        — argv[2]/[3] 修正 + 補 Gemini/Copilot/Cursor hooks
tests/mcp-auto-update-cross-platform.test.js  — 新增 5 case 對應 Codex review findings
tests/p3-update-event-semantics.test.js   — P3-lock test 對齊 openSync wx 新架構
package.json / docs/README*               — 1.17.22 → 1.17.23，三語系同步
CHANGELOG.md                              — v1.17.23 條目
```

## v1.17.24 新增 / 修改（用戶用量報告頁）

新增檔：

```
src/routes/me.js                          — /api/me/profile + /api/me/report endpoint
src/public/me/index.html                  — 用戶端自助登入 + 三 tab 報告 UI
tests/me-report.test.js                   — 7 case 防退化
```

修改既有：

```
src/app.js                                — 掛 /api/me 路由 + /me 靜態頁
package.json / docs/README*               — 1.17.23 → 1.17.24，三語系同步
CHANGELOG.md                              — v1.17.24 條目
```

## v1.17.25 新增 / 修改（user role 改成帳密登入）

新增檔：

```
db/010_user_password_login.sql            — must_change_password 欄位 + email 索引
src/jobs/seed-default-passwords.js        — boot 時補預設密碼（idempotent）
```

修改既有：

```
src/routes/me.js                          — 加 POST /login + /change-password；/profile 多回 must_change_password
src/public/me/index.html                  — Email/password 登入；強制首次改密碼 UI
src/index.js                              — boot 時呼叫 seedDefaultPasswords()
tests/me-report.test.js                   — 新增 6 case
package.json / docs/README*               — 1.17.24 → 1.17.25，三語系同步
CHANGELOG.md                              — v1.17.25 條目
```

## v1.17.26 修改（admin 建 user 自動套預設密碼）

修改既有：

```
src/routes/admin.js                       — POST /users 對 user role 無密碼時套
                                            DEFAULT_USER_PASSWORD + must_change_password=TRUE
tests/me-report.test.js                   — 新增 1 case
package.json / docs/README*               — 1.17.25 → 1.17.26，三語系同步
CHANGELOG.md                              — v1.17.26 條目
```

## v1.17.27 修改（hotfix /ownmind/me/ API path）

```
src/public/me/index.html                  — fetch path 從 /api/me/ 改 /ownmind/api/me/
package.json / docs/README*               — 1.17.26 → 1.17.27
CHANGELOG.md                              — v1.17.27 條目
```

## v1.17.28 修改（hotfix bar chart CSS）

```
src/public/me/index.html                  — .bar-row / .bar / .bar-label CSS 重寫
package.json / docs/README*               — 1.17.27 → 1.17.28
CHANGELOG.md                              — v1.17.28 條目
```

## v1.17.29 修改（bar chart 數字標籤）

```
src/public/me/index.html                  — barChart 加 .bar-value 顯示數值
package.json / docs/README*               — 1.17.28 → 1.17.29
CHANGELOG.md                              — v1.17.29 條目
```

## v1.17.30 修改（bar chart 平均線 + 專案主要貢獻者拆分）

```
src/routes/me.js                          — projects 改回 contributors[{name,sessions,turns}]
src/public/me/index.html                  — barChart 加平均線；專案表加「主要負責人」「其他貢獻者」欄
package.json / docs/README*               — 1.17.29 → 1.17.30
CHANGELOG.md                              — v1.17.30 條目
```

## v1.17.31 修改（其他貢獻者門檻過濾）

```
src/public/me/index.html                  — 加 max(20輪, 10% 專案總輪次) 門檻過濾偶發測試
package.json / docs/README*               — 1.17.30 → 1.17.31
CHANGELOG.md                              — v1.17.31 條目
```

## v1.17.32 修改（個人 tab：活動紀錄 + 鐵律完整列表 + 遵守率）

```
src/routes/me.js                          — me.compliance LEFT JOIN 全鐵律；新增 me.activity 200 筆
src/public/me/index.html                  — 個人 tab 加活動紀錄表 + 鐵律加遵守率欄
package.json / docs/README*               — 1.17.31 → 1.17.32
CHANGELOG.md                              — v1.17.32 條目
```

## v1.17.33 修改（鐵律/活動紀錄分頁）

```
src/routes/me.js                          — me.activity 移除 LIMIT 200
src/public/me/index.html                  — 加 paginate / renderPager helper、CSS .pager
package.json / docs/README*               — 1.17.32 → 1.17.33
CHANGELOG.md                              — v1.17.33 條目
```

## v1.17.34 修改（自訂日期範圍 + 專案大小寫合併）

```
src/routes/me.js                          — 加 start/end 參數 + LOWER(TRIM) 專案 group key
src/public/me/index.html                  — range select 加「自訂…」 + date inputs + 套用按鈕
package.json / docs/README*               — 1.17.33 → 1.17.34
CHANGELOG.md                              — v1.17.34 條目
```

## v1.17.35 修改（團隊趨勢圖切換 metric）

```
src/routes/me.js                          — team.users + 3 trend charts 加 tokens/turns（FULL OUTER JOIN）
src/public/me/index.html                  — 加 metricSel 下拉、users 表加 Token/輪次 欄、barChart 加 fmtBig
package.json / docs/README*               — 1.17.34 → 1.17.35
CHANGELOG.md                              — v1.17.35 條目
```

## v1.17.36 修改（專案來源加 handoffs）

```
src/routes/me.js                          — projectHandoffQ 補 handoffs 進 projMap，含 my_handoffs
src/public/me/index.html                  — 專案表加「交接」欄；只交接無 session_log 顯示「N 次交接」
package.json / docs/README*               — 1.17.35 → 1.17.36
CHANGELOG.md                              — v1.17.36 條目
```

## v1.17.37 修改（auto-write session_log 帶 project + 多 signal 全收）

```
mcp/index.js                              — AUTO_PROJECT 從 CLAUDE_PROJECT_DIR 偵測；
                                            emergencySessionLog 寫 project + duration_turns；
                                            訂 SIGTERM/SIGINT/SIGHUP/SIGQUIT 全部 + process.on('exit') 保險
package.json / docs/README*               — 1.17.36 → 1.17.37
CHANGELOG.md                              — v1.17.37 條目
```

## v1.17.38 修改（5 個 server-side 反向稽核）

```
src/routes/me.js                          — 5 個 audit query + me.audit_findings 回傳結構
src/public/me/index.html                  — #audit-findings 卡片區、CSS .audit-card 三色
package.json / docs/README*               — 1.17.37 → 1.17.38
CHANGELOG.md                              — v1.17.38 條目
```

## v1.17.39 修改（Codex round 3 audit 全面修補）

```
src/routes/me.js                          — P1.1 orphan_session 日期 gate; P1.2 compliance_gap
                                            縮窄事件; P2.1 heartbeat LOWER 比對; P2.2 high
                                            findings 寫 audit_logs; P3 blind_spot + team_blindspot
src/public/me/index.html                  — 加 unobservable_source / team_blindspot label
package.json / docs/README*               — 1.17.38 → 1.17.39
CHANGELOG.md                              — v1.17.39 條目
```

## v1.17.40 修改（compliance call 系統強制）

```
mcp/index.js                              — 加 autoComplyForToolCall()，CallToolRequestSchema
                                            handler 成功後自動 emit iron_rule_compliance
                                            event（source='system_auto'）
package.json / docs/README*               — 1.17.39 → 1.17.40
CHANGELOG.md                              — v1.17.40 條目
```

## v1.17.41 修改（Codex round 4 後 auto-compliance 誠信修補）

```
mcp/index.js                              — autoComplyForToolCall：action 改 'observed_trigger'
                                            移除 handoff IR-008/009/024 over-extrapolation
                                            加 dedup set + 補 appendCompliance()
                                            移除 silent catch 改 console.error
src/routes/me.js                          — compliance query 排除 system_auto 於 comply 計數，
                                            加獨立 observed 欄位
src/public/me/index.html                  — 鐵律表多「系統觀測」欄、遵守率只算 AI 自報
package.json / docs/README*               — 1.17.40 → 1.17.41
CHANGELOG.md                              — v1.17.41 條目
```

## v1.17.42 修改（compliance gap 拆兩等級）

```
src/routes/me.js                          — complianceGapQ 拆 gap_unobserved / gap_unverified
                                            兩種 finding type 不同 severity
src/public/me/index.html                  — TYPE_LABEL 加 compliance_unobserved/unverified
package.json / docs/README*               — 1.17.41 → 1.17.42
CHANGELOG.md                              — v1.17.42 條目
```

## v1.17.43 修改（gap rule_code 關聯 + 文案中性化）

```
src/routes/me.js                          — sensitive CTE 加 expected_rules 陣列
                                            has_matching_manual_comply 加 rule_code = ANY 比對
                                            unverified 訊息改成中性描述
package.json / docs/README*               — 1.17.42 → 1.17.43
CHANGELOG.md                              — v1.17.43 條目
```

## v1.17.44 修改（前端 unverified label 對齊）

```
src/public/me/index.html                  — TYPE_LABEL.compliance_unverified 改中性文案
package.json / docs/README*               — 1.17.43 → 1.17.44
CHANGELOG.md                              — v1.17.44 條目
```

## v1.17.45 修改（自動觀測搬到伺服器端）

```
src/routes/activity.js                    — 新增 autoEmitObservedTrigger()，
                                            POST /batch 收到 memory_disable / save / update
                                            (iron_rule) 自動補 observed_trigger
                                            source='system_server_auto'
src/routes/me.js                          — gap audit 跟 compliance 統計 source 比對
                                            從 != 'system_auto' 改成 NOT LIKE 'system_%'
package.json / docs/README*               — 1.17.44 → 1.17.45
CHANGELOG.md                              — v1.17.45 條目
```

## v1.17.46 修改（/me 專案排行 UI 精簡）

```
src/public/me/index.html                  — 移除「我的份」欄（header + cell + desc）
                                            移除「N 位偶發測試略過」註記
src/routes/me.js                          — 清掉 my_sessions / my_handoffs 累計欄位
package.json / README* / docs/README*     — 1.17.45 → 1.17.46
CHANGELOG.md                              — v1.17.46 條目
```

## v1.17.75 修改（文件化 Claude Code 體驗降級 — β 路線：保留 hook / 不再投資補救）

```
README.md / docs/README.zh-TW.md / docs/README.ja.md
                                          — 三語新增「Client Experience Matrix」/
                                            「OwnMind 在不同 AI 客戶端的體驗」/
                                            「異なるAIクライアントでのOwnMind体験」
                                            區塊。對照表列每個 client 的 banner
                                            體驗 + 為什麼。Claude Code 標 ⚠️ 降級
                                            體驗、鏈到 Anthropic Issue #11120。
                                            版本徽章 1.17.74 → 1.17.75
package.json                              — 1.17.74 → 1.17.75
CHANGELOG.md / FILELIST.md                — 補 v1.17.75 條目
```

## v1.17.74 修改（contract test 參數化 — 1→8 條，覆蓋 broadcast / multi-part / 空 / 壞 parts 變體）

```
tests/ownmind-tty-echo.test.js            — contract test 從 1 條變 8 條（contractCases
                                            array + for loop 生成 8 個獨立 it），
                                            覆蓋單 banner / 雙 banner / 廣播 / 廣播+混合 /
                                            multi-part / 空 parts / 壞 part / 純文字
                                            8 種變體；conditional cleanup 修 v1.17.73 m-6
                                            （13→20 條）
package.json                              — 1.17.73 → 1.17.74
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.73 → 1.17.74
CHANGELOG.md / FILELIST.md                — 補 v1.17.74 條目
```

## v1.17.73 修改（結構性拆 v1.17.71/v1.17.72 fixture 集體偽陽性雷 — IR-007 follow-through）

```
tests/ownmind-tty-echo.test.js            — 新增 mcpToolResponse / legacyToolResponse
                                            兩個 fixture helper；4 條既有測試遷移到
                                            mcpToolResponse、2 條（測試名明確談 content
                                            的）保留 legacyToolResponse、混搭兩種
                                            shape；新增 1 條結構性 contract test
                                            「兩種 shape 同 banner 文字產出 block 必須
                                            一致」（12→13 條）
package.json                              — 1.17.72 → 1.17.73
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.72 → 1.17.73
CHANGELOG.md / FILELIST.md                — 補 v1.17.73 條目
```

## v1.17.72 修改（修 v1.17.71 在場感 100% 失效 — IR-007 雷型）

```
hooks/ownmind-tty-echo.cjs                — extractBanners 同時支援兩種 prod
                                            tool_response 結構：直接 array（MCP
                                            tool 走這條）+ { content: [...] }
                                            （舊版/其他 tool）。v1.17.71 只處理
                                            後者，導致 prod MCP banner 抽不到、
                                            user 100% 看不到。
tests/ownmind-tty-echo.test.js            — +1 IR-007 regression test（11→12 條），
                                            用真實 PostToolUse stdin 截下來的結構
                                            （含 session_id / hook_event_name /
                                            tool_use_id 等真實欄位）；先紅後綠
                                            驗證 fix。
package.json                              — 1.17.71 → 1.17.72
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.71 → 1.17.72
CHANGELOG.md / FILELIST.md                — 補 v1.17.72 條目
```

## v1.17.71 修改（OwnMind 在場感 — 直寫 user terminal 繞過 AI 過濾）

```
hooks/ownmind-tty-echo.cjs                — 新增（跨平台 Node helper）
                                            從 PostToolUse stdin 讀 JSON、抓
                                            「【OwnMind vX.Y.Z】XXX」 + 「📢 OwnMind」
                                            banner、合併成招牌區塊、寫 /dev/tty 或
                                            \\.\CONOUT$；fallback 寫 banner-pending.jsonl
                                            給下次 SessionStart 補印；嚴禁寫
                                            stderr/stdout（規格 #3 不被 AI 吃）
scripts/install-helpers/add-post-tool-use-hook.cjs
                                          — 新增（idempotent merge PostToolUse hook 到
                                            ~/.claude/settings.json；backup + atomic +
                                            rollback；保留 user 既有設定）
hooks/ownmind-session-start.sh            — 開頭呼叫 flush-pending-banners.js 補印
                                            （stderr → user-visible 通道）+ 清空檔案
hooks/lib/flush-pending-banners.js        — 新增（一次 spawn node 串流讀整個
                                            pending file 印 stderr，避免 bash while
                                            loop per-line spawn 在 50+ 積壓時卡頓）
install.sh                                — MCP 設定後呼叫 add-post-tool-use-hook helper
install.ps1                               — Windows 對稱（用同一支 cjs helper）
tests/ownmind-tty-echo.test.js            — 新增（11 條：banner 抽取/合併/廣播/空輸入/
                                            壞 JSON/fallback JSON Lines/stderr 必空白/
                                            主路徑 tty 寫入）
tests/add-post-tool-use-hook.test.js      — 新增（8 條：created/added/skipped 三狀態 +
                                            idempotent + backup + 絕對 path + 壞 JSON
                                            不污染原檔）
package.json                              — 1.17.70 → 1.17.71
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.70 → 1.17.71
CHANGELOG.md / FILELIST.md                — 補 v1.17.71 條目
```

## v1.17.70 修改（升級備份自動清除 — IR-027 邏輯卡控）

```
scripts/interactive-upgrade.sh            — 升級成功末段加 find -mtime +N sweep
                                            支援 OWNMIND_BACKUP_RETENTION_DAYS env
                                            覆蓋（預設 7 天）。Sweep 失敗不擋升級
scripts/interactive-upgrade.ps1           — 對稱實作 Get-ChildItem + Where
                                            LastWriteTime -lt cutoff + Remove-Item
scripts/bootstrap.sh                      — 修復路徑 log 訊息「3 天後可手動刪除」
                                            改「下次升級自動清除超過 7 天」
scripts/bootstrap.ps1                     — 同上 PS 版本
tests/sweep-old-backups.test.js           — 新增（8 條：find -mtime / -maxdepth /
                                            -name 邊界 + retention 0 + 空目錄 +
                                            upgrade 腳本內容檢查）
package.json                              — 1.17.69 → 1.17.70
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.69 → 1.17.70
CHANGELOG.md / FILELIST.md                — 補 v1.17.70 條目
```

## v1.17.69 修改（MCP 回傳合併單一 text part — 修 Claude Code 看不到技巧提示）

```
mcp/lib/compose-tool-response.js          — 新增（純函式：把 broadcast / tag / body / tip
                                            合併成單一 { type: 'text', text } part，
                                            所有 MCP client 渲染一致）
mcp/index.js                              — 把原本 4 個 contentParts.push 換成
                                            composeToolResponse({...}) 呼叫
tests/mcp-tool-response-shape.test.js     — 新增（8 條：單一 part 結構、tag/body
                                            視覺分隔、有無 broadcast/tip 都正確）
tests/tip-every-call.test.js              — 更新 assert pattern 對齊新結構，仍驗
                                            tip 必須無條件附（不能有 % 10 閘門）
package.json                              — 1.17.68 → 1.17.69
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.68 → 1.17.69
CHANGELOG.md / FILELIST.md                — 補 v1.17.69 條目
```

## v1.17.68 修改（settings.json `--update` 殘留地雷 + 401 觀測管道 IR-007/IR-038）

```
src/middleware/auth.js                    — 401 path 加 logger.warn('auth_failed',...)
                                            帶 route / ip / masked_key / ua；新增 maskApiKey()
                                            純函式 + 第 4 個參數 deps={} 測試注入點
scripts/install-helpers/self-check.cjs    — 新增 checkApiKeyFormat 純函式（不打 server，
                                            純看 key 字串長相），抓 v1.17.9 之前 install.ps1
                                            沒過濾 flag-like args 殘留的 settings.json 存量問題
                                            （Bob 從 2026-03-26 到 2026-05-08 都吃 401 的根因）；
                                            排在 api_credentials 之前，fail 訊息明確指向修法
tests/auth-401-observability.test.js      — 新增（7 條：maskApiKey 邊界 + auth middleware
                                            401 / no-bearer logger.warn shape）
tests/self-check.test.js                  — 加 10 條 checkApiKeyFormat 測試
package.json                              — 1.17.67 → 1.17.68
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.67 → 1.17.68
CHANGELOG.md / FILELIST.md                — 補 v1.17.68 條目
```

## v1.17.67 修改（v1.17.66 Windows scanner task hotfix + IR-007 防同類雷）

```
scripts/windows/register-scanner-task.ps1 — 刪除 -DontStartIfOnBatteries 和
                                            -StopIfGoingOnBatteries 兩個拼錯的 PS param
                                            （v1.17.66 上線後讓 Windows scanner task 完全沒
                                            註冊、token 用量報告卡 0）；
                                            stale Write-Host 「every 30 min」修為「every 120 min」
tests/ps1-windows-compat.test.js          — 反轉舊 test：assert 兩個壞 param 必須不存在；
                                            新增 New-ScheduledTaskSettingsSet param 白名單驗證
                                            （IR-007 Persistent Bug Protocol — 防字串對 / 語意錯
                                            的同類雷）
install.ps1                              — Tee register-scanner-task.ps1 stdout+stderr 到
                                            ~/.ownmind/logs/register-task-<ts>.log；訊息「30 分鐘」
                                            改「120 分鐘」（IR-038 觀測管道）
scripts/install-helpers/self-check.cjs    — detectSchedulerDetail 新增 readLatestRegisterLog()，
                                            把最新 register-task 日誌（最多 8KB）併入
                                            scheduler_detail.register_log，admin 可從
                                            install_check_logs 直接看 PS error stack
package.json                             — 1.17.66 → 1.17.67
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.66 → 1.17.67
CHANGELOG.md / FILELIST.md               — 補 v1.17.67 條目
```

## v1.17.65 修改（autostash fallback 死路徑 — v1.17.24 backlog 清完）

```
mcp/index.js                             — autostash fallback 從 git pull --autostash 改 --ff-only
                                            （主路徑 + fallback 都帶 --autostash 等於沒 fallback）
tests/mcp-auto-update-cross-platform.test.js — 加 1 條 regression（fallback args 不可含 --autostash）
package.json                             — 1.17.64 → 1.17.65
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.64 → 1.17.65
CHANGELOG.md / FILELIST.md               — 補 v1.17.65 條目
```

## v1.17.64 修改（self-check endpoint + auth header 修正）

```
scripts/install-helpers/self-check.cjs   — checkApiCredentials 從 POST /api/init 改 GET /api/memory/init；
                                            api_credentials + uploadReport 兩處 header 從 X-OwnMind-API-Key
                                            改 Authorization: Bearer
tests/self-check.test.js                 — 加 2 條 regression（驗 URL + Bearer header）
package.json                             — 1.17.63 → 1.17.64
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.63 → 1.17.64
CHANGELOG.md / FILELIST.md               — 補 v1.17.64 條目
```

## v1.17.63 修改（安裝/升級自動 self-check + 上傳 log）

```
scripts/install-helpers/self-check.cjs   — 新增（7 項本機檢查、寫 log、上傳 server）
db/011_install_check_logs.sql            — 新增（schema migration）
src/routes/debug.js                      — 新增（POST /api/debug/install-check 收 log）
tests/self-check.test.js                 — 新增（13 case：parseArgs / summarize / sanitizePath / buildReport / smoke）
tests/debug-route.test.js                — 新增（5 case：auth / 成功 / 缺欄位 / 過大 / DB 錯）
src/app.js                               — 掛 /api/debug router
install.sh / install.ps1                 — 結尾呼叫 self-check（trigger=post_install）
scripts/interactive-upgrade.sh / .ps1    — 結尾呼叫 self-check（trigger=post_upgrade）
docs/superpowers/specs/2026-05-08-install-self-check-design.md — 新增（spec）
package.json                             — 1.17.62 → 1.17.63
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.62 → 1.17.63
CHANGELOG.md                             — v1.17.63 條目
```

## v1.17.62 修改（修自動更新兩個 silent fail）

```
mcp/index.js                              — execFile(NPM_CMD,...) 加 shell: IS_WINDOWS（修 Bob Windows EINVAL）
                                            update_applied 後重發心跳、讀 disk package.json 新版號
                                            （修 Dana 長跑 MCP cached 舊版回報）
package.json                              — 1.17.61 → 1.17.62
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.61 → 1.17.62
CHANGELOG.md                              — v1.17.62 條目
```

## v1.17.61 修改（/me 報告頁加 MCP 通道盲點提示）

```
src/public/me/index.html                  — 新增 .blindspot-notice CSS + main 最上方固定提示元素
package.json                              — 1.17.60 → 1.17.61
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.60 → 1.17.61
CHANGELOG.md                              — v1.17.61 條目
```

## v1.17.60 修改（settings.json 安全讀取 + 自動更新 lock 旗標）

```
scripts/install-helpers/load-settings-safe.cjs   — 新增（loadOrSkip helper：壞掉印警告 + exit(0)，原檔不洗掉）
scripts/update.sh                                — 4 處 node -e 改用 loadOrSkip（Claude / Gemini / Copilot / Cursor）
scripts/update.ps1                               — 對應 4 處 node 腳本改用 loadOrSkip
mcp/index.js                                     — 加 module-scope _lockHeld 旗標；外層 catch 只在自己持有時 cleanup
tests/load-settings-safe.test.js                 — 新增（7 case：missing / valid / corrupt-no-overwrite / caller-write-also-no-clobber / non-object JSON / empty file / unreadable）
package.json                                     — 1.17.59 → 1.17.60
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.59 → 1.17.60
CHANGELOG.md                                     — v1.17.60 條目
```

## v1.17.59 修改（mcp/index.js 三項硬化）

```
shared/helpers.js                         — 加 sanitizeErrorMessage / pushBounded / shouldSkipDuplicate 三個 helper
mcp/index.js                              — 套 helper：complianceEvents 改環形緩衝 (上限 500)、
                                            console.error 過 sanitize、_autoComplyDedup 改 Map+滑動時間窗
tests/mcp-hardening.test.js               — 新增（17 case：3 個 helper 各自的快樂路徑/邊界/分鐘交界回歸）
package.json                              — 1.17.58 → 1.17.59
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.58 → 1.17.59
CHANGELOG.md                              — v1.17.59 條目
```

## v1.17.58 修改（IR-024 commit-msg hook）

```
hooks/ownmind-git-commit-msg              — 新增（bash 鉤子，IR-024 commit message 偵測）
install.sh                                — 加 5 行：複製 ownmind-git-commit-msg 到 ~/.ownmind/git-hooks/
install.ps1                               — 加對應邏輯（Copy-AsLf + LF 行尾）
tests/git-hook-co-authored-by.test.js     — 新增（7 個測試）
package.json                              — 1.17.57 → 1.17.58
README.md / docs/README.zh-TW.md / docs/README.ja.md — 1.17.57 → 1.17.58
CHANGELOG.md                              — v1.17.58 條目
docs/superpowers/specs/2026-05-07-git-hook-co-authored-by-design.md  — 新增（spec）
docs/superpowers/plans/2026-05-07-git-hook-co-authored-by.md         — 新增（plan）
```

## v1.17.57 修改（整體分析報告改正面肯定 + 拿掉冗餘描述句）

```
src/lib/llm-narrative.js                 — SYSTEM_PROMPT rule 3 範例改正面
                                            肯定（主要開發者、貢獻極大）；
                                            rule 6 強化禁止個人風險評價
                                            （離職、扛太多、接不下去、bus factor）
src/public/me/index.html                 — 拿掉「過去 N 天的全團隊使用分析…」描述句
tests/llm-narrative.test.js              — pin 正面肯定 + 個人風險禁用詞
package.json / README* / docs/README*    — 1.17.56 → 1.17.57
CHANGELOG.md                             — v1.17.57 條目
```

## v1.17.56 修改（v1.17.55 顯示問題修正：Tokens 估算 + 長專案名）

```
src/routes/me-narrative.js               — project_ranking 改 (user_id, tool)
                                            bridge：usr_tok CTE 加總期間總量，
                                            proj CTE 按 turns 比例分配；
                                            REGEXP_REPLACE 砍掉「( ... )」描述
src/routes/me.js                         — myProjects + projectContrib 兩個
                                            SQL 同步加 REGEXP_REPLACE 名稱正規化
src/public/me/index.html                 — renderProjectRankingTable：欄頭加 *，
                                            下方註明「估算值（按輪次比例分配）」
package.json / README* / docs/README*    — 1.17.55 → 1.17.56
CHANGELOG.md                             — v1.17.56 條目
```

## v1.17.55 修改（各專案活動量排行加 Tokens + 成本欄）

```
src/routes/me-narrative.js               — project_ranking SQL：加 CTE 從
                                            token_usage_daily 用 (user_id,
                                            tool, session_id) JOIN，按
                                            last_ts ${tfTs} 過濾，加總 5 種
                                            tokens + cost_usd
src/public/me/index.html                 — renderProjectRankingTable：表頭加
                                            「Tokens」「成本」兩欄，tokens 用
                                            fmtBig（1.2M），成本 $X.XX；
                                            6. 標題改「大家的OwnMind行為分析」
                                            2. 標題改「大家的OwnMind版本」
package.json / README* / docs/README*    — 1.17.54 → 1.17.55
CHANGELOG.md                             — v1.17.55 條目
```

## v1.17.54 修改（LLM prompt 友善白話 + 踩坑三段式）

```
src/lib/llm-narrative.js                 — SYSTEM_PROMPT 改寫：
                                            1. project_friction schema 改 {what,impact,mitigation}
                                            2. Rule 2 範例改白話（去「大使」用「常用 AI 的人」）
                                            3. Rule 5 三段式 friction + 禁 AI 自言自語
                                            4. 新增 Rule 7 行話黑名單（大使/賦能/對齊/扛...）
src/public/me/index.html                 — renderNarrativeInsights 新增 renderFricItem()
                                            三段式渲染：what 粗體、impact/mitigation 灰字 13px
                                            向下相容舊版字串
tests/llm-narrative.test.js              — pin prompt 規格（三段式 / 行話黑名單 / AI 工作量）
package.json / README* / docs/README*    — 1.17.53 → 1.17.54
CHANGELOG.md                             — v1.17.54 條目
```

## v1.17.53 修改（誠信表 UX 強化）

```
src/routes/me-narrative.js                — compliance query 加 WHERE 過濾全零列
                                            ORDER BY 改 violate DESC, user_name, rule_code
src/public/me/index.html                  — renderComplianceTable() violate > 0 紅色加粗
package.json / README* / docs/README*     — 1.17.52 → 1.17.53
CHANGELOG.md                              — v1.17.53 條目
```

## v1.17.52 修改（誠信表加「使用者」欄）

```
src/routes/me-narrative.js                — compliance query 改 GROUP BY (user_id, rule_code)
                                            JOIN users + memories(user_id, code) 帶該 user 自己的 title
src/public/me/index.html                  — renderComplianceTable() 多一欄「使用者」
                                            ORDER BY user_name → rule_code
package.json / README* / docs/README*     — 1.17.51 → 1.17.52
CHANGELOG.md                              — v1.17.52 條目
```

## v1.17.51 修改（誠信表 IR 代號加白話說明）

```
src/routes/me-narrative.js                — compliance query 改 CTE，JOIN memories
                                            DISTINCT ON (code) 取最新 IR title
src/public/me/index.html                  — renderComplianceTable() 顯示 IR title
                                            （代號粗體 + title 灰字小字）
package.json / README* / docs/README*     — 1.17.50 → 1.17.51
CHANGELOG.md                              — v1.17.51 條目
```

## v1.17.50 修改（事件代號加白話說明）

```
src/public/me/index.html                  — 加 EVENT_LABELS 對照表 + eventLabel() helper
                                            renderEventTypesTable / renderUpdateHealthTable
                                            從 1 欄改 2 欄（原始代號 + 白話說明）
package.json / README* / docs/README*     — 1.17.49 → 1.17.50
CHANGELOG.md                              — v1.17.50 條目
```

## v1.17.66 修改（Windows 平台硬化 + 觀測管道修補 IR-038）

```
新增 — 三個共用 helper（架構性，防同類雷）：
  scripts/windows/lib/find-git-bash.ps1     — Find-GitBash + Test-IsGitBash，過濾 WSL relay
  scripts/install-helpers/safe-spawn.cjs    — Win32-friendly execFile（shell:false + windowsHide:true）
  scripts/install-helpers/path-to-win32.cjs — MSYS /c/X ↔ Win32 C:\X 雙向轉換

新增 — 視窗隱藏 launcher：
  scripts/windows/run-hidden.vbs            — wscript GUI subsystem 隱藏 console（Bug #7-a）

新增 — OpenSpec：
  openspec/changes/archive/v1.17.66-windows-hardening/proposal.md  — 七個 bug 根因 + 架構性發現
  openspec/changes/archive/v1.17.66-windows-hardening/spec.md      — Helper API + GIVEN/WHEN/THEN
  openspec/changes/archive/v1.17.66-windows-hardening/tasks.md     — 0~10 階段執行清單

修改：
  scripts/interactive-upgrade.ps1           — 三處 bash 改用 Find-GitBash（#1）
                                              所有 Out-File 加 -Encoding utf8（#6）
                                              整個流程包 try/finally，self-check 在 finally 保證執行（#4）
                                              verify_local 失敗不再 Rollback（觀測 ≠ 升級成功與否）
  scripts/install-helpers/self-check.cjs    — checkScheduler 改用 safeSpawn 拿掉 shell:true（#2）
                                              新增 appendSpool / retrySpool / 重寫 uploadReport（#4 spool）
                                              新增 collectEnv / detectShellChain / detectBashResolution
                                              / detectSchedulerDetail / detectWindowsEncoding（IR-038）
                                              buildReport 接受可選 env 參數
  scripts/windows/register-scanner-task.ps1 — Action 改用 wscript.exe + run-hidden.vbs 包 node.exe（#7-a）
                                              RepetitionInterval 30 → 120 分鐘（#7-b）
                                              加 -DontStartIfOnBatteries + -StopIfGoingOnBatteries（#7-b）
  tests/ps1-windows-compat.test.js          — 加 v1.17.66 Bug #1 / #6 / #7 / #4 reproduction（11 條）
  tests/self-check.test.js                  — 加 v1.17.66 Bug #2 / #4 spool / collectEnv reproduction（9 條）
  package.json / README* / docs/README*     — 1.17.65 → 1.17.66
  CHANGELOG.md                              — v1.17.66 條目
```

## v1.17.49 修改（預設密碼不再公開洩漏）

```
src/public/me/index.html                  — 登入頁副標 + 改密碼 placeholder 拿掉明碼
src/public/index.html                     — addUser() 收到 default_password 後 alert 顯示
src/routes/admin.js                       — POST /admin/users response 多 default_password
                                            （shared default 才回傳，admin 自設不洩漏）
package.json / README* / docs/README*     — 1.17.48 → 1.17.49
CHANGELOG.md                              — v1.17.49 條目
```

## v1.17.48 修改（整體分析 上線後修正）

```
src/public/me/index.html                  — 長條圖 CSS 修正（flex 衝突 → width 固定）
                                            「敘事報告」→「整體分析」改名
src/lib/llm-narrative.js                  — prompt 加正反例 + 規範洞察必須具體
package.json / README* / docs/README*     — 1.17.47 → 1.17.48
CHANGELOG.md                              — v1.17.48 條目
```

## docs — OpenSpec 慣例文件（housekeeping，無版號）

> v1.18.9 release 後、把 OpenSpec 資料夾慣例（archive 凍結政策、搬遷規則、驗證流程）落成檔案。
> 對應 PR #37（archive 第一次搬遷）的政策正式化。

新增：
```
openspec/CONVENTIONS.md            — OpenSpec 提案資料夾慣例
                                      第 1 段：資料夾結構（changes/ + archive/）
                                      第 2 段：進入 archive 的時機（已 release / 已棄用）
                                      第 3 段：搬遷規則（git mv + 正名 + 同步外部引用）
                                      第 4 段：archive 凍結政策（歷史快照、不再追改舊路徑）
                                      第 5 段：驗證流程（grep 範本確認 archive 外無殘留）
```

修改：
```
FILELIST.md                        — 本區塊（新增 CONVENTIONS.md 項目）
```

## v1.18.9 新增 / 修改 (MCP 工具 latency 埋點)

> 原規劃 5 大功能（誤殺回饋按鈕 + 4 種安全告警 + 健康度分頁 + sig helper + latency 埋點）三次棄用後、最終 release 只剩 latency 埋點。詳見 `openspec/changes/archive/v1.18.9-mcp-latency-tracking/proposal.md`。

新增檔:
```
mcp/lib/log-mcp-call.js                  — logMcpCallSafe helper、寫 mcp_call event
                                            含 latency_ms。任何 logEvent 失敗都被吞掉、
                                            不阻塞 tool call。跟 enrich-error.js 同 pattern
tests/log-mcp-call.test.js               — 6 unit tests
                                            涵蓋 payload 對 / null tool fallback / logEvent throw
                                            不 escalate / latency_ms 是 0 也照寫
openspec/changes/archive/v1.18.9-mcp-latency-tracking/  — 完整提案 + 棄用紀錄
                                            proposal.md / spec.md / tasks.md
                                            「曾規劃但棄用」的 2 個 commit (8bcfc69 / 127b740)
                                            git log 可查
```

修改的既有檔:
```
mcp/index.js                             — setRequestHandler 主流程入口記 startedAt、
                                            成功 path 寫 mcp_call event、失敗 path
                                            error event + mcp_call status=error 都帶 latency_ms
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.8 → 1.18.9
```

刪除（曾嘗試但棄用）:
```
src/utils/feedback-sig.js                — block_feedback HMAC sig（part 2 棄用）
src/lib/block-feedback.js                — block_feedback core handler（part 2 棄用）
src/routes/block-feedback.js             — POST /api/feedback/block 路由（part 2 棄用）
src/routes/feedback-page.js              — GET /feedback/block 確認頁（part 2 棄用）
tests/feedback-sig.test.js / tests/block-feedback.test.js — block_feedback 測試
src/lib/safety-detect.js                 — 4 種安全告警偵測（part 3 棄用）
src/utils/safety-audit.js                — writeSafetyAudit helper（part 3 棄用）
tests/safety-detect.test.js / tests/safety-audit.test.js — safety 測試
```
git 歷史保留 commit 8bcfc69 + 127b740 作「曾嘗試」紀錄。

## v1.18.8 新增 / 修改 (error helper 抽出 + unit test + 健康度日報 launchd)

新增檔:
```
mcp/lib/enrich-error.js                  — enrichErrorDetails + errorAliasFields helper
                                            v1.18.6 inline 拆出、加 errorAliasFields 共用
tests/enrich-error.test.js               — 25 unit tests
                                            涵蓋基本欄位/stack/http_status/payload_summary/
                                            隱私邊界/向後相容/update_failed 情境整合
scripts/launchd/com.ownmind.health-report-daily.plist — 每天 09:00 跑日報、輸出 reports/
                                            admin 端手動 launchctl load 安裝
```

修改的既有檔:
```
mcp/index.js                             — (1) 移除 inline enrichErrorDetails、改 import
                                          — (2) update_failed event 用 errorAliasFields
                                            DRY、跟 error event 共用結構化邏輯
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.7 → 1.18.8
```

## v1.18.7 新增 / 修改 (update_failed event 同步補 error 結構化欄位)

修改的既有檔:
```
mcp/index.js                        — update_failed event (line ~1324) inline 補
                                      error_message/error_code/error_name/stack alias
                                      跟 v1.18.6 的 error event 欄位一致、不用 helper
                                      (因 update_failed 語意不同沒 args 概念)
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.6 → 1.18.7
```

## v1.18.6 新增 / 修改 (Error 事件觀測缺口補完)

修改的既有檔:
```
mcp/index.js                        — 新增 enrichErrorDetails helper（line ~28）
                                      改 catch error 從 { tool_name, error } 變
                                      豐富 details (error/error_message/error_name/
                                      stack/http_status/payload_summary)
                                      payload_summary 只記結構 metadata、不洩內容
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.5 → 1.18.6
```

## v1.18.5 新增 / 修改 (Hotfix: big skill sync 從 v1.18.0 上線就壞)

修改的既有檔:
```
hooks/lib/conditional-sync-cli.js   — syncToAllTools 從 top-level static import
                                      改成 if (refreshed) 區段內 dynamic import
                                      失敗時 outer try/catch 抓住、graceful degrade
scripts/update.sh                   — 開頭加 idempotent check 補裝 js-yaml
                                      --no-save 不污染 package.json
scripts/update.ps1                  — Windows 版同步補
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.4 → 1.18.5
```

## v1.18.4 新增 / 修改 (產品健康度日報雛形 + tool='unknown' fallback 修正)

新增檔:
```
scripts/health-report-daily.sh         — bash SSH 進 prod 跑 6 條 SQL、輸出健康度日報
                                         只看絕對數字、不算比例、避免冷啟動誤導
```

修改的既有檔:
```
mcp/ownmind-log.js                     — TOOL_NAME fallback 從 'unknown' 改 'claude-code'
                                         加 OWNMIND_CLIENT_TOOL alias、向後相容
mcp/index.js                           — 同上、TOOL_NAME 跟 ownmind-log.js 同步
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.3 → 1.18.4
```

## v1.18.3 新增 / 修改 (Hotfix: lint metadata 漏餵 + reply-lint Stop hook 安裝腳本漏修)

修改的既有檔:
```
src/routes/memory.js                  — POST + PUT lintIronRule call 加 metadata
src/routes/admin-iron-rule-upgrade.js — PUT lintIronRule call 加 metadata
scripts/update.sh                     — 補 add-stop-hook + add-post-tool-use-hook
scripts/update.ps1                    — 同步補 (Windows)
tests/iron-rule-origin-context.test.js — +3 regression test (lint 收 metadata 才正確)
package.json / README* / CHANGELOG.md / FILELIST.md — 1.18.2 → 1.18.3
```

## v1.18.2 新增 / 修改 (鐵律時空背景 origin_context — Vin 提的需求)

新增檔:
```
src/utils/iron-rule-origin-context.js — pure helpers (validate/render/inject/capture)
tests/iron-rule-origin-context.test.js — 19 cases
scripts/backfill-iron-rule-origin-context.js — backfill 35 條既有鐵律 user_direct
```

修改的既有檔:
```
src/utils/iron-rule-quality.js        — lintIronRule 加 checkOriginContext (warning 不擋)
mcp/index.js                          — ownmind_save schema 加 4 個 iron_rule 欄位 + 自動 capture
skills/ownmind-memory.md              — 教 AI 主動帶 origin_event/user_quote/origin_confidence
src/routes/admin-iron-rule-upgrade.js — PUT 接受 origin_event/user_quote、injectOriginSection
src/public/index.html                 — 升級助手 modal 加 2 input + 藍色提示框
src/routes/memory.js                  — PUT metadata-only update bypass content lint
```

## v1.18.1 新增 / 修改 (Hotfix: 移除 IR-037 中英混雜 lint)

修改的既有檔:
```
src/utils/iron-rule-quality.js        — 移除 IR-037 (兩處)
src/utils/iron-rule-suggest.js        — 加 round-trip lint check + lint_ok/errors
src/routes/admin-iron-rule-upgrade.js — response 加 lint_ok/lint_errors
src/public/index.html                 — modal 進場預先顯示 lint errors
tests/iron-rule-quality.test.js       — IR-037 測試改反映新行為
scripts/audit-real-iron-rules-lint.js — 新檔: baseline audit
```

## v1.18.0 新增 / 修改（鐵律對齊 SKILL.md 標準 + 1 big skill 跨工具 + conditional sync + 升級助手 admin Web UI）

新增檔（rc1 schema）:
```
src/utils/iron-rule-frontmatter.js    — js-yaml JSON_SCHEMA 安全 frontmatter 解析
db/013_iron_rule_previous_content.sql — ALTER memories ADD previous_content TEXT
tests/iron-rule-frontmatter.test.js   — 13 cases
tests/iron-rule-quality-skill-md.test.js — 26 cases (S1-S9 + B1 fallback)
```

新增檔（rc2 conditional sync + 跨工具）:
```
src/utils/iron-rule-sync.js           — buildBigSkillMd + buildReferenceFile + syncToFilesystem (3 kind) + atomic write
hooks/lib/conditional-sync.js         — readCache/writeCache/shouldRefreshCache/runConditionalSync
hooks/lib/conditional-sync-cli.js     — sh hook wrapper (額外打 sync 拿鐵律 list、syncToAllTools)
tests/sync-token-endpoint.test.js     — 10 cases (generateSyncToken pure + validateSyncToken)
tests/iron-rule-sync.test.js          — 23 cases (pure builders + 真 fs IO)
tests/conditional-sync.test.js        — 24 cases (mock fetch + tmp cache)
```

新增檔（rc3 升級助手）:
```
src/utils/iron-rule-suggest.js        — template-based SKILL.md proposal (ASCII name + hash)
src/routes/admin-iron-rule-upgrade.js — 3 endpoints (status/suggest/upgrade)
tests/iron-rule-suggest.test.js       — 8 cases
```

修改的既有檔:
```
src/utils/iron-rule-quality.js        — lintIronRule dispatch (frontmatter → schema lint / 沒 → legacy)
src/routes/memory.js                  — POST/PUT format/warnings response + previous_content + GET /sync-token
src/utils/syncToken.js                — queryFn 注入式 (test 友善)
src/app.js                            — mount /api/admin/iron-rules
src/public/index.html                 — admin 新「鐵律升級」tab + diff modal + 升級流程
hooks/ownmind-session-start.sh        — 改用 conditional-sync-cli wrapper + fallback
package.json / package-lock.json      — + js-yaml ^4.1.1
package.json / README* / docs/README* — 1.17.99 → 1.18.0
CHANGELOG.md / FILELIST.md            — v1.18.0 條目
```

OpenSpec:
```
openspec/changes/archive/v1.18.0-iron-rule-schema/proposal.md (v4)
openspec/changes/archive/v1.18.0-iron-rule-schema/spec.md
openspec/changes/archive/v1.18.0-iron-rule-schema/tasks.md
```

## v1.17.99 新增 / 修改（Dedup helper 抽 + MCP log 帶 id + 移 node-fetch 依賴）

新增檔：

```
src/utils/activity-insert.js                 — pure helper：normalizeClientEventId + insertActivityLog
tests/mcp-log-event-uuid.test.js             — 3 條 mcp/ownmind-log client_event_id 測試
```

修改的既有檔：

```
src/routes/activity.js                       — import helper、移除 inline UUID_V4_REGEX 跟 40 行 INSERT
tests/activity-batch-dedup.test.js           — buildApp 改用真 helper、+6 條 helper unit test
mcp/ownmind-log.js                           — logEvent 加 client_event_id (UUID v4)、移 node-fetch import
mcp/index.js                                 — 移 node-fetch import (改用 global fetch)
mcp/package.json                             — 移 node-fetch dep
mcp/package-lock.json                        — 同步 lock
package.json / README* / docs/README*        — 1.17.98 → 1.17.99
CHANGELOG.md                                 — v1.17.99 條目
```

## v1.17.98 新增 / 修改（Server 端 dedup — client_event_id partial unique index）

新增檔：

```
db/012_activity_event_dedup.sql              — ALTER activity_logs + partial unique index
tests/activity-batch-dedup.test.js           — 8 條 server dedup 行為測試（mock query）
```

修改的既有檔：

```
src/routes/activity.js                       — POST /batch 拆兩條 INSERT path、加 deduped 計數
hooks/ownmind-reply-lint.js                  — buildComplianceEvents 加 client_event_id (UUID v4)
tests/reply-lint-pending-spool.test.js       — +2 條 client_event_id 必須出現在 spool / archive
tests/flush-compliance-spool.test.js         — +1 條 flush 必須轉送 client_event_id
package.json / README* / docs/README*        — 1.17.97 → 1.17.98
CHANGELOG.md                                 — v1.17.98 條目
```

## v1.17.97 新增 / 修改（SessionStart spool flush + Windows path 兩個 v1.17.96 backlog 解掉）

新增檔：

```
hooks/lib/flush-compliance-spool.js          — SessionStart 補送 helper
tests/flush-compliance-spool.test.js         — 11 條 flush helper 契約測試
tests/reply-lint-pending-spool.test.js       — 5 條 hook 條件 spool 測試
```

修改的既有檔：

```
hooks/ownmind-reply-lint.js                  — postEvents 回 boolean、只在 POST 失敗才 spool pending
hooks/ownmind-session-start.sh               — 加一段呼叫 flush-compliance-spool.js（接在 banner flush 後）
install.sh                                   — 2.1 + 2.2 段加 cygpath -w（Git Bash on Windows）
package.json / README* / docs/README*        — 1.17.96 → 1.17.97
CHANGELOG.md                                 — v1.17.97 條目
```

## v1.17.96 新增 / 修改（Stop hook 整合：回話品質 lint 真的卡 AI）

新增檔：

```
hooks/ownmind-reply-lint.js                  — Stop hook 主程式：讀 transcript、抽最後一輪 assistant text、跑 lintReply、違反印 banner + 報 violate
scripts/install-helpers/add-stop-hook.cjs    — install-time helper，把 Stop hook idempotent 寫進 ~/.claude/settings.json
tests/reply-lint-hook.test.js                — 12 條 hook 行為測試
tests/add-stop-hook.test.js                  — 9 條 install helper 測試
```

修改的既有檔：

```
install.sh                                   — 加段 2.2 呼叫 add-stop-hook.cjs（接在 v1.17.71 PostToolUse hook 後）
install.ps1                                  — Windows 版同樣加段 2.2
package.json / README* / docs/README*        — 1.17.95 → 1.17.96
CHANGELOG.md                                 — v1.17.96 條目
FILELIST.md                                  — hooks/ + scripts/install-helpers/ 樹補新檔
```

## v1.17.47 修改（/me 敘事報告）

```
src/lib/llm-narrative.js                  — 新增（llm-switch OpenAI-compatible wrapper）
src/lib/narrative-cache.js                — 新增（in-memory TTL hash cache）
src/routes/me-narrative.js                — 新增（mechanical + insights endpoints + PII redact）
src/app.js                                — 掛 /api/me/narrative 路由（須在 /api/me 之前）
src/public/me/index.html                  — 加第 4 tab「📊 敘事報告」+ 11 section render
                                            + auto LLM trigger + range change re-fetch
.env.example                              — 補 LLM_SWITCH_API_KEY 說明
tests/narrative-cache.test.js             — 4 tests
tests/llm-narrative.test.js               — 13 tests
tests/me-narrative.test.js                — 8 tests（4 mechanical + 4 insights）
docs/superpowers/specs/2026-05-07-me-narrative-report-design.md  — 新增（spec）
docs/superpowers/plans/2026-05-07-me-narrative-report-plan.md    — 新增（plan）
package.json / README* / docs/README*     — 1.17.46 → 1.17.47
CHANGELOG.md                              — v1.17.47 條目
```
