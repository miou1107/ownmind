# v1.19.13 — 規格（GIVEN / WHEN / THEN）

對應 `proposal.md` §2。

---

## S1：value-side keyword 偵測 — 賦值樣式才命中

### S1.1 點分隔識別字含 password 字樣應放行（regression 重點）

```
GIVEN  detectSecretLike() 第一個參數 value = "anydesk.bot_kkvin.unattended_password"
       options 未設 skip_keyword（即 false）
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 { detected: false }
```

### S1.2 一般描述句含 password 字樣應放行

```
GIVEN  value = "the password is in the vault"
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 { detected: false }
```

### S1.3 多層點分隔 reference 含 token 字樣應放行

```
GIVEN  value = "hermes.telegram.bot_token"
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 { detected: false }
```

### S1.4 程式碼風格的 env reference 應放行

```
GIVEN  value = "process.env.MY_PASSWORD"
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 { detected: false }
```

### S1.5 賦值樣式（冒號）含值 ≥ 8 應命中

```
GIVEN  value = "password: MyP@ssw0rd123"
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 detected = true
       rule 以 "keyword:" 開頭
       reason 含「賦值樣式」字樣
       matched_text 為觸發片段（≤ 80 字）
```

### S1.6 賦值樣式（等號）含值 ≥ 8 應命中

```
GIVEN  value = "API_TOKEN=abc123XYZ987"
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 detected = true
       rule = "keyword:token"
       matched_text 含 "API_TOKEN=abc123XYZ987"（截 80）
```

### S1.7 賦值樣式但值 < 8 應放行（form label / placeholder）

```
GIVEN  value = "password: hi"
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 { detected: false }
```

### S1.8 賦值樣式含引號值應命中

```
GIVEN  value = 'secret = "supersecretvalue"'
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 detected = true
       rule = "keyword:secret"
```

### S1.9 賦值樣式但 token 字樣**字母前綴**複合詞應放行

```
GIVEN  value = "mypassword=12345678"   // 「mypassword」整個是一個變數名、字母前綴
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 { detected: false }
```

> 理由：賦值 regex 用 `(?<![A-Za-z])` 負向 lookbehind、`mypassword` 中 `p` 前面是 `y`（字母）→ lookbehind 失敗 → 不命中、放行。
>
> **注意此 lookbehind 刻意不對稱**：只擋字母前綴、不擋底線／hyphen／數字前綴。理由：snake_case／kebab-case 的 env var 名稱（`foo_password=`、`reset_password_token=`、`-token=`、`123token=`）通常確實在賦值真實密鑰、擋是正確的；只有英文複合詞（`mypassword`、`mytoken`）才是「整個字本身是描述、不是密鑰名稱」、需要保護。
>
> **同註**：本 spec S1.9 用 `mypassword=12345678` 而非 `mypassword=hello12345`、避免總長 ≥ 20 字觸發長度啟發式、混淆 keyword 階段的測試焦點。

### S1.10 賦值樣式 + snake_case 前綴 → 命中（設計意圖）

```
GIVEN  value = "foo_password=secretvalue123"   // snake_case env var
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 detected = true
       rule = "keyword:password"
```

> 補強 S1.9 的對稱說明：snake_case env var 命名落到「賦值賦真實值」場景、仍要擋。

---

## S2：matched_text 回傳

### S2.1 keyword 命中時帶 matched_text

```
GIVEN  value = "password: MyP@ssw0rd123"
WHEN   呼叫 detectSecretLike(value)
THEN   回傳 result.matched_text 為字串
       result.matched_text.length ≤ 80
       result.matched_text 含「password: MyP@ssw0rd」（前綴比對即可）
```

### S2.2 regex 命中時也帶 matched_text

```
GIVEN  value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
WHEN   呼叫 detectSecretLike(value)
THEN   result.rule = "regex:github_pat"
       result.matched_text 為字串、≤ 80 字
       result.matched_text 含 "ghp_abc"（前綴比對即可）
```

### S2.3 length heuristic 命中時也帶 matched_text

```
GIVEN  value 為 30 字純英數字（無中文、無賦值樣式）
WHEN   呼叫 detectSecretLike(value)
THEN   result.rule = "heuristic:long_alnum"
       result.matched_text 為字串、≤ 80 字
```

### S2.4 detected = false 時不帶 matched_text

```
GIVEN  value = "hello world"
WHEN   呼叫 detectSecretLike(value)
THEN   result.matched_text === undefined
```

---

## S3：memory-secret-guard 400 回應加 matched_text

### S3.1 命中時 400 body 含 matched_text

```
GIVEN  type = 'env'、title = 'test'、content = 'password: MyP@ssw0rd123'
WHEN   呼叫 validateMemoryContent({ type, title, content })
THEN   回傳 ok = false
       status = 400
       body.detected_by 以 "keyword:" 開頭
       body.matched_text 為非空字串
```

### S3.2 沒命中時 matched_text 不存在

```
GIVEN  type = 'env'、title = 'test'、content = 'anydesk.bot_kkvin.unattended_password'
WHEN   呼叫 validateMemoryContent({ type, title, content })
THEN   回傳 ok = true（regression 重點）
```

---

## S4：bot.kkvin.com 整段內容 regression

### S4.1 完整原案例放行

```
GIVEN  type = 'env'
       title = 'bot.kkvin.com 遠端訪問方式總覽'
       content 為 2026-05-24 對話中 AI 試著存的全文（含 AnyDesk ID、
              Tailscale IP、ssh.bot.kkvin.com.vin.password 等密鑰名稱）
WHEN   呼叫 validateMemoryContent({ type, title, content })
THEN   回傳 ok = true
```

---

## S5：既有行為不變

### S5.1 Regex 偵測仍命中已知格式

```
GIVEN  value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
WHEN   呼叫 detectSecretLike(value)
THEN   result.detected = true
       result.rule = "regex:github_pat"
```

### S5.2 Title／description keyword 仍命中

```
GIVEN  value = "abc"、title = "production password"
WHEN   呼叫 detectSecretLike(value, { title })
THEN   result.detected = true
       result.rule = "keyword:password"
```

### S5.3 Length heuristic 仍命中

```
GIVEN  value 為 30 字純英數字
WHEN   呼叫 detectSecretLike(value)
THEN   result.detected = true
       result.rule = "heuristic:long_alnum"
```

### S5.4 bypass flag 仍生效

```
GIVEN  value = "password: MyP@ssw0rd123"、allow_bypass = true
WHEN   呼叫 detectSecretLike(value, { allow_bypass: true })
THEN   result.detected = false
```

### S5.5 narrative type 仍跳 keyword 偵測

```
GIVEN  type = 'iron_rule'、content = 'password: hello12345'
WHEN   呼叫 validateMemoryContent({ type, title, content })
THEN   回傳 ok = true   // skip_keyword = true、不跑 keyword
```

> 即 v1.19.13 不破壞 narrative 類型的 opt-out 例外。
