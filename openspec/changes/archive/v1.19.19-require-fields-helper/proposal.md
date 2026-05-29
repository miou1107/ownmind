# v1.19.19 — Site-wide requireFields helper (debuggable error messages for required API fields)

- **Author**: Vin
- **Date**: 2026-05-24
- **Status**: in progress
- **Estimated version**: v1.19.19 (internal refactor + DX improvement, patch level)

---

## 0. One-sentence summary

Extract the hand-written "required fields: x, y, z" 400 boilerplate from each of the site's 6 endpoints into a shared `requireFields()` helper; the returned error payload contains `missing` / `received` / `expected`, so the AI and other clients can immediately tell what got dropped when they hit it.

---

## 1. Design rationale

### 1.1 The pitfall after the v1.19.18 release

After the v1.19.18 release, when trying to run `ownmind_log_session` to record, both connects received:

```
API 400: 必填欄位：tool, model, summary
```

But three fields were actually sent. After debugging, it turned out the AI wrote the tool call with `parameter` instead of `antml:parameter` (missing the namespace prefix); when the MCP server parsed it, it only recognized the first field, the other three were dropped, the client sent a body missing fields, and the server correctly returned 400.

The problem: **the error message cannot self-correct**. The AI sees "required fields: tool, model, summary" and thinks "but I clearly filled in all three", with no way to tell whether they were dropped at the args-parse stage, the transport stage, or it's a server-side problem.

### 1.2 Why this should be a long-term fix, not just patching the one session.js endpoint

Surveying the whole site, there are **6 endpoints** using the same "required fields: x, y, z" generic boilerplate ([grep result](#32-coverage-survey)). Each one will hit the same pit, and when the AI moves to another endpoint it has to guess all over again.

Long-term solution: write a `requireFields()` helper, apply it site-wide, unify the error format, and let clients parse and respond reliably.

### 1.3 Why choose a server-side helper over client-side schema validation

Both legs should be done (see [§5 follow-up leg B](#5-leg-b-mcp-client-side-schema-pre-validation-recorded-as-backlog)). This version does server-side first because:

- **Broad impact**: a server-side fix takes effect for all clients (MCP / admin UI / third-party scripts), not just MCP
- **Small change**: 6 endpoints change one line each, plus one shared helper, ~150 lines
- **Does not depend on a client upgrade**: client v1.19.x are all still in the field, no need for everyone to re-run update.sh
- **Leg B (MCP client schema validate) is larger**: it touches the MCP framework and tool dispatch layer, estimated 3-5 days, listed as backlog first

---

## 2. Design

### 2.1 Helper signature

```js
// src/utils/require-fields.js
export function requireFields(body, required, options = {}) {
  const received = body || {};
  const missing = required.filter(f => {
    const v = received[f];
    return v === undefined || v === null || v === '';
  });

  if (missing.length === 0) return null; // passes

  return {
    error: '必填欄位缺少',
    missing,
    expected: required,
    received: redactSensitive(received, options.sensitiveKeys),
  };
}
```

### 2.2 Endpoint usage

Old:

```js
const { tool, model, summary } = req.body;
if (!tool || !model || !summary) {
  return res.status(400).json({ error: '必填欄位：tool, model, summary' });
}
```

New:

```js
const validation = requireFields(req.body, ['tool', 'model', 'summary']);
if (validation) return res.status(400).json(validation);
const { tool, model, summary } = req.body;
```

### 2.3 Error payload example

Old (previous version):
```json
{ "error": "必填欄位：tool, model, summary" }
```

New (v1.19.19):
```json
{
  "error": "必填欄位缺少",
  "missing": ["tool", "model"],
  "expected": ["tool", "model", "summary"],
  "received": { "summary": "test summary" }
}
```

The AI / client, seeing `missing` + `received`, immediately knows:
- I sent summary, but tool / model are gone
- → they were dropped at the args-parse stage, not a server-side bug

### 2.4 Security: received auto-redacts sensitive fields

Fields in `received` like password / token / api_key / secret are auto-redacted to `<REDACTED>`, to avoid the error response leaking sensitive data. `options.sensitiveKeys` can add custom fields.

---

## 3. Coverage survey

### 3.1 The 6 endpoints to migrate

| File | Line | Required fields |
|---|---|---|
| `src/routes/session.js` | 44 | tool, model, summary |
| `src/routes/admin.js` | 147 | email |
| `src/routes/handoff.js` | 17 | project, from_tool, from_model, content |
| `src/routes/memory.js` | 899 | type, title, content |
| `src/routes/memory.js` | 1688 | parent_title, chunks (array) |
| `src/routes/secret.js` | 79 | key, value (**sensitive**, value must be redacted) |

### 3.2 Those that already partly self-correct but have an inconsistent format

| File | Line | Current state |
|---|---|---|
| `src/routes/usage/pricing.js` | 62 | uses `必填欄位缺少：${missing.join(',')}` — already says which is missing, but the format is unstructured; this version unifies it |

### 3.3 Out of scope (untouched this version)

- ~80 other 400 responses (business logic each inline, not the required-fields generic boilerplate)
- MCP client-side schema pre-validation (→ backlog leg B)
- Existing clients' parsing of the old error format (**Breaking change assessment**: the MCP client / admin UI both only look at res.ok and res.status, do not parse the error payload content, so this version is a **backward-compatible** enhancement that does not break existing clients)

---

## 4. Effort

| Item | Lines |
|---|---|
| `src/utils/require-fields.js` (incl. sensitive-key redaction) | 50 |
| `tests/require-fields.test.js` (unit tests, ~10 cases) | 100 |
| 6 endpoint migrations (~3-line diff each) | 18 |
| pricing.js unified over (in passing) | 5 |
| reproduction test: session.js missing fields returns the new format | 30 |
| version + CHANGELOG + FILELIST + trilingual README | 50 |
| **Total** | ~250 lines |

Engineering time: ~1-2 hours (incl. deploy + verification).

---

## 5. Leg B (MCP client-side schema pre-validation) recorded as backlog

This version only does leg A (server-side helper). Leg B (the MCP client uses inputSchema to enforce-validate args, throwing client-side directly when fields are missing) is larger, listed as a standalone backlog item:

- Trigger signal: after the v1.19.19 release, track whether generic 400s still occur frequently; if the AI still hits them often (even though the new message already includes missing), start leg B
- Estimate: 3-5 days
- Scope: add a schema validator to the dispatch layer of mcp/index.js, validate before every tool call enters its case, and throw with an args dump if missing

→ Write into OwnMind project memory (the to-do-list preference convention).

---

## 6. Risk checkpoints

- [ ] `requireFields()` safely handles `body=null` / `body=undefined` (does not throw)
- [ ] For `body={}` it returns all missing
- [ ] For array required fields (e.g. chunks) it validates correctly (how to judge an array empty string, empty array?)
- [ ] `secret.js`'s value is redacted in received (**the most critical security check**)
- [ ] The full existing 1827 tests green
- [ ] The new unit tests + reproduction test green
- [ ] After deploy, MCP `ownmind_log_session` sent with a missing-fields body returns the new format (incl. missing/received/expected)
- [ ] After deploy, the admin UI's existing features are unaffected (run an add-memory once via the admin UI, confirm it does not break)
- [ ] Trilingual version 1.19.19
