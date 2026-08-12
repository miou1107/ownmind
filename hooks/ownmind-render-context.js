#!/usr/bin/env node
/**
 * OwnMind Render Context — turns a hook-context response into the text a hook prints.
 *
 * Usage: … | node ownmind-render-context.js <version> <trigger>
 * Output: the reminder, or nothing when there is nothing to say. Always exits 0.
 *
 * issue #94 — the shell hook used to build this inside inline `node -e` source, which is why
 * it carried its own copy of the trigger alias table (see TRIGGER_TAG_ALIASES). Filtering now
 * happens on the server and rendering happens here, so that copy is gone and the two hooks
 * print the same line instead of two translations of the same idea.
 *
 * Both response shapes are accepted, and which one arrived is detected from the body rather
 * than passed in as a flag: `{ data: { counts, rules } }` is v1.26.151's endpoint, a bare
 * `{ data: [...] }` is the `/type/iron_rule` fallback an older server answers. Reading the
 * shape means the shell does not have to tell us which curl succeeded, and a mismatch between
 * what the shell thinks it fetched and what it actually fetched cannot produce a wrong line.
 */

import { readFileSync } from 'fs';
import { renderHookContextLine } from '../shared/hook-context.js';
import { ruleMatchesTrigger } from '../shared/helpers.js';

const version = process.argv[2] || '?';
const trigger = process.argv[3] || 'command';

let body = '';
try {
  body = readFileSync(0, 'utf8');
} catch {
  process.exit(0);
}

let parsed;
try {
  parsed = JSON.parse(body);
} catch {
  // Deliberately not silent. The shell reads stdout only, so this reaches Claude Code's hook
  // stderr, where a server returning HTML or a proxy error page is worth seeing. Exiting 0
  // keeps the promise that a hook never fails the command it inspects.
  console.error(`ownmind-render-context: cannot parse the response body (${body.slice(0, 200)})`);
  process.exit(0);
}

const data = parsed?.data ?? parsed;
const isNew = !!(data && !Array.isArray(data) && data.counts);
const isLegacy = Array.isArray(data);
if (!isNew && !isLegacy) {
  // Valid JSON in neither shape — a server that answered 200 with an error object, a proxy
  // page, a truncated body. Reported, not treated as "no rules": those two are the pair this
  // hook has been rewritten three times to keep apart. The non-zero status is what the shell
  // turns into a `render_context_failed` record; stdout stays empty so nothing wrong is shown.
  console.error(`ownmind-render-context: unrecognised response shape (${body.slice(0, 200)})`);
  process.exit(1);
}
const legacy = !isNew;
// The new endpoint has already selected the relevant rules. The fallback endpoint has not —
// it returns every iron rule on the account and always left the matching to its caller — so
// the filter has to run here. Importing `ruleMatchesTrigger` rather than restating it is the
// point of moving this out of the shell's inline `node -e`: that copy of the alias table is
// what issue #91 is about, and there is now no second copy on this path.
const rules = legacy
  ? (Array.isArray(data) ? data : []).filter((r) => ruleMatchesTrigger(r, trigger))
  : (data.rules || []);

const out = [];

if (!legacy) {
  // The counts line answers "what does OwnMind think is happening" and "did it actually look".
  // The how-to line rides along only on the full listing: deploy and delete are the infrequent
  // triggers, and the command path has no session state to throttle a repeat with — putting it
  // on `commit` would print it in front of every commit, which is how a hint becomes wallpaper.
  const line = renderHookContextLine({
    version,
    trigger,
    counts: data.counts,
    withHowTo: trigger !== 'commit',
  });
  if (line) out.push(line);
}

if (rules.length > 0) {
  if (legacy) {
    // The pre-v1.26.151 output, unchanged. It is what a user on an un-upgraded server sees,
    // and its Chinese is the Chinese they have been seeing all along — translating it here
    // would change the fallback into a third thing nobody asked for. The English-source route
    // applies to the new line, which is the one being introduced.
    if (trigger === 'commit') {
      out.push(`【OwnMind v${version}】鐵律檢查：commit 操作，${rules.length} 條規則已確認 ✓`);
    } else {
      const tag = `【OwnMind v${version}】鐵律觸發（${trigger}）`;
      out.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      out.push(tag);
      out.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      rules.forEach((r) => out.push(`  ⚠️  ${r.code || 'IR-?'}: ${r.title}`));
      out.push('');
      out.push(`回應格式要求：AI 的第一行必須是「${tag}」，讓使用者看到鐵律觸發。`);
    }
  } else if (trigger !== 'commit') {
    // On the new path the counts line above already names the trigger and the iron-rule
    // count, and carries the instruction to relay it. A second banner repeating both would
    // be the same sentence twice, so this is the listing only. commit stays compact: the
    // count in the line above is the whole message there.
    out.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    rules.forEach((r) => out.push(`  ⚠️  ${r.code || 'IR-?'}: ${r.title}`));
    out.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
}

if (out.length > 0) console.log(out.join('\n'));
