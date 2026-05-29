# v1.19.13 — spec (GIVEN / WHEN / THEN)

Maps to `proposal.md` §2.

---

## S1: value-side keyword detection — only matches on the assignment pattern

### S1.1 A dot-separated identifier containing the word password should pass (key regression)

```
GIVEN  detectSecretLike()'s first argument value = "anydesk.bot_example.unattended_password"
       options doesn't set skip_keyword (i.e. false)
WHEN   call detectSecretLike(value)
THEN   returns { detected: false }
```

### S1.2 A general descriptive sentence containing the word password should pass

```
GIVEN  value = "the password is in the vault"
WHEN   call detectSecretLike(value)
THEN   returns { detected: false }
```

### S1.3 A multi-level dot-separated reference containing the word token should pass

```
GIVEN  value = "hermes.telegram.bot_token"
WHEN   call detectSecretLike(value)
THEN   returns { detected: false }
```

### S1.4 A code-style env reference should pass

```
GIVEN  value = "process.env.MY_PASSWORD"
WHEN   call detectSecretLike(value)
THEN   returns { detected: false }
```

### S1.5 An assignment pattern (colon) with a value ≥ 8 should match

```
GIVEN  value = "password: MyP@ssw0rd123"
WHEN   call detectSecretLike(value)
THEN   returns detected = true
       rule begins with "keyword:"
       reason contains the wording 「賦值樣式」
       matched_text is the triggering fragment (≤ 80 chars)
```

### S1.6 An assignment pattern (equals) with a value ≥ 8 should match

```
GIVEN  value = "API_TOKEN=abc123XYZ987"
WHEN   call detectSecretLike(value)
THEN   returns detected = true
       rule = "keyword:token"
       matched_text contains "API_TOKEN=abc123XYZ987" (truncated to 80)
```

### S1.7 An assignment pattern but value < 8 should pass (form label / placeholder)

```
GIVEN  value = "password: hi"
WHEN   call detectSecretLike(value)
THEN   returns { detected: false }
```

### S1.8 An assignment pattern with a quoted value should match

```
GIVEN  value = 'secret = "supersecretvalue"'
WHEN   call detectSecretLike(value)
THEN   returns detected = true
       rule = "keyword:secret"
```

### S1.9 An assignment pattern but a **letter-prefixed** compound word for the token keyword should pass

```
GIVEN  value = "mypassword=12345678"   // the whole "mypassword" is a variable name, letter prefix
WHEN   call detectSecretLike(value)
THEN   returns { detected: false }
```

> Reason: the assignment regex uses a `(?<![A-Za-z])` negative lookbehind; in `mypassword`, the character before `p` is `y` (a letter) → lookbehind fails → no match → pass.
>
> **Note this lookbehind is deliberately asymmetric**: it only blocks a letter prefix, not an underscore / hyphen / digit prefix. Reason: snake_case / kebab-case env var names (`foo_password=`, `reset_password_token=`, `-token=`, `123token=`) genuinely tend to assign a real key, so blocking them is correct; only English compound words (`mypassword`, `mytoken`) are "the whole word itself is a description, not a key name" and need protection.
>
> **Same note**: this spec's S1.9 uses `mypassword=12345678` rather than `mypassword=hello12345`, to avoid a total length ≥ 20 chars triggering the length heuristic and confusing the keyword-stage test focus.

### S1.10 Assignment pattern + snake_case prefix → match (design intent)

```
GIVEN  value = "foo_password=secretvalue123"   // snake_case env var
WHEN   call detectSecretLike(value)
THEN   returns detected = true
       rule = "keyword:password"
```

> Reinforces S1.9's symmetric note: snake_case env var naming falls into the "assigning a real value" scenario, still to be blocked.

---

## S2: matched_text return

### S2.1 On keyword match, carry matched_text

```
GIVEN  value = "password: MyP@ssw0rd123"
WHEN   call detectSecretLike(value)
THEN   returns result.matched_text as a string
       result.matched_text.length ≤ 80
       result.matched_text contains "password: MyP@ssw0rd" (prefix match is enough)
```

### S2.2 On regex match, also carry matched_text

```
GIVEN  value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
WHEN   call detectSecretLike(value)
THEN   result.rule = "regex:github_pat"
       result.matched_text is a string, ≤ 80 chars
       result.matched_text contains "ghp_abc" (prefix match is enough)
```

### S2.3 On length heuristic match, also carry matched_text

```
GIVEN  value is 30 pure-alphanumeric chars (no Chinese, no assignment pattern)
WHEN   call detectSecretLike(value)
THEN   result.rule = "heuristic:long_alnum"
       result.matched_text is a string, ≤ 80 chars
```

### S2.4 When detected = false, no matched_text

```
GIVEN  value = "hello world"
WHEN   call detectSecretLike(value)
THEN   result.matched_text === undefined
```

---

## S3: memory-secret-guard 400 response adds matched_text

### S3.1 On match, the 400 body contains matched_text

```
GIVEN  type = 'env', title = 'test', content = 'password: MyP@ssw0rd123'
WHEN   call validateMemoryContent({ type, title, content })
THEN   returns ok = false
       status = 400
       body.detected_by begins with "keyword:"
       body.matched_text is a non-empty string
```

### S3.2 On no match, matched_text doesn't exist

```
GIVEN  type = 'env', title = 'test', content = 'anydesk.bot_example.unattended_password'
WHEN   call validateMemoryContent({ type, title, content })
THEN   returns ok = true (key regression)
```

---

## S4: bot.example.com full-content regression

### S4.1 The full original case passes

```
GIVEN  type = 'env'
       title = 'bot.example.com 遠端訪問方式總覽'
       content is the full text the AI tried to save in the 2026-05-24 conversation (including the AnyDesk ID,
              Tailscale IP, ssh.bot.example.com.vin.password and other key names)
WHEN   call validateMemoryContent({ type, title, content })
THEN   returns ok = true
```

---

## S5: existing behavior unchanged

### S5.1 Regex detection still matches known formats

```
GIVEN  value = "ghp_abcdefghijklmnopqrstuvwxyz0123456789AB"
WHEN   call detectSecretLike(value)
THEN   result.detected = true
       result.rule = "regex:github_pat"
```

### S5.2 Title / description keyword still matches

```
GIVEN  value = "abc", title = "production password"
WHEN   call detectSecretLike(value, { title })
THEN   result.detected = true
       result.rule = "keyword:password"
```

### S5.3 Length heuristic still matches

```
GIVEN  value is 30 pure-alphanumeric chars
WHEN   call detectSecretLike(value)
THEN   result.detected = true
       result.rule = "heuristic:long_alnum"
```

### S5.4 The bypass flag still works

```
GIVEN  value = "password: MyP@ssw0rd123", allow_bypass = true
WHEN   call detectSecretLike(value, { allow_bypass: true })
THEN   result.detected = false
```

### S5.5 narrative types still skip keyword detection

```
GIVEN  type = 'iron_rule', content = 'password: hello12345'
WHEN   call validateMemoryContent({ type, title, content })
THEN   returns ok = true   // skip_keyword = true, keyword doesn't run
```

> I.e. v1.19.13 doesn't break the narrative types' opt-out exception.
