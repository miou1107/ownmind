/**
 * The one line a hook prints in front of an operation, and what goes in it.
 *
 * issue #94 — that line has three jobs, and the version it replaces did none of them:
 *
 *   1. say what OwnMind thinks is happening (`鐵律觸發（install）` said it, badly);
 *   2. show that OwnMind actually did something, per memory category;
 *   3. leave a way to see the contents.
 *
 * Only iron rules were ever fetched, so job 2 was impossible in the data, not just in the
 * rendering: a user could not tell "no team standard applied here" from "team standards were
 * never looked at". Those are very different, and one of them is a defect the display was
 * structurally unable to report.
 */

/**
 * The five categories the reminder lists, in display order, and nothing else.
 *
 * The line is "which of my memories constrain what is about to happen". Everything here
 * tells the operation how to go; everything left out records what something is.
 * `project` and `env` are background, `standard_detail` is the body text of a team standard
 * already counted one row up, and `session_log` / `portfolio` are neither.
 *
 * Order is by whose permission you would need to break the rule, hardest first. A team
 * standard belongs to the company and one person cannot waive it; an iron rule is the user's
 * own words and they can decide, in the moment, to override it. What you cannot waive should
 * not be the thing that scrolls off.
 *
 * It also keeps the small numbers visible. Iron rules run to 70+ on a real account and team
 * standards to single digits, so ordering by count — or by anything correlated with it —
 * hides exactly the row the user is least free to ignore.
 *
 * Labels are English on purpose, and the rendered line carries an instruction to translate
 * them. That is the route already used for the startup tip (hooks/lib/render-session-context.js
 * — "translate it if you are speaking another language"): the source text is written once, in
 * English, and the model renders it in whatever language it is speaking to this user. Hard-coding
 * Chinese here would have shipped one language and called it done.
 *
 * v1.26.151 did hard-code Chinese, on a misreading of the issue that asked for this. v1.26.152
 * is the correction.
 */
export const HOOK_CONTEXT_TYPES = [
  { type: 'team_standard', label: 'Team standards' },
  { type: 'iron_rule', label: 'Iron rules' },
  { type: 'coding_standard', label: 'Coding standards' },
  { type: 'principle', label: 'Working principles' },
  { type: 'profile', label: 'Preferences' },
];

/**
 * Turn the rows of all five categories into what a hook prints.
 *
 * Pure, and separate from the route, so the decision that actually matters here — which rows
 * count, and which categories send their titles — is testable without a database.
 *
 * @param {Array<{type: string, code?: string, title: string, tags?: string[]}>} rows
 * @param {string} trigger
 * @param {(rule: object, trigger: string, opts: object) => boolean} matches — ruleMatchesTrigger
 * @returns {{counts: Record<string, number>, rules: Array<{code?: string, title: string}>}}
 */
export function tallyHookContext(rows, trigger, matches) {
  const counts = {};
  const totals = {};
  const names = {};
  for (const { type } of HOOK_CONTEXT_TYPES) {
    counts[type] = 0;
    totals[type] = 0;
    names[type] = [];
  }
  const rules = [];

  for (const row of rows || []) {
    if (!Object.hasOwn(counts, row.type)) continue;
    // v1.26.154 — the denominator. Counted before the match, so it says how many of this kind
    // the account holds, not how many survived the filter. A bare `4` could not tell "four
    // apply" from "four exist"; `4/32` answers both, and it was the first question the display
    // provoked from the person it was built for.
    totals[row.type] += 1;
    // Only iron rules keep "untagged means relevant to everything". The other four are not
    // tagged for triggers, because until now nothing ever asked them to be — under the old
    // contract every one of them would match every operation. See ruleMatchesTrigger.
    if (!matches(row, trigger, { untaggedMatchesAll: row.type === 'iron_rule' })) continue;
    counts[row.type] += 1;
    // v1.26.154 — titles for every matching row, not just iron rules.
    //
    // The count alone did not make anyone read them. Measured on the release before this one:
    // the line said `Team standards 4` in front of a commit, and the AI that read it opened
    // none of the four. One of them was "Commit 前品管三步驟", whose second step is to request
    // a code review — skipped. A name is harder to walk past than a number.
    //
    // What keeps this from becoming the wall of text the counts replaced is the window in
    // shared/edit-reminder-state.js: the names go out once an hour per session per trigger,
    // and every operation in between gets the counts alone.
    names[row.type].push(row.title);
    if (row.type === 'iron_rule') rules.push({ code: row.code, title: row.title });
  }

  return { counts, totals, names, rules };
}

/**
 * What the user is doing, in their words rather than the trigger's.
 *
 * `install` is the reason this table exists. A user debugging an auth header watched
 * `鐵律觸發（install）` appear under every `curl` carrying an `X-API-KEY` and asked what was
 * being installed — nothing was. The trigger name is an internal category and had no business
 * being the thing shown.
 */
export const TRIGGER_LABELS = {
  edit: 'File edit',
  commit: 'Commit',
  deploy: 'Deploy',
  delete: 'Delete',
  install: 'Install / credentials',
  // v1.26.155 — not "Publish" and not "Deploy": both read as shipping software, and this fires
  // on a reply to an issue as much as on a public post. What it has to convey is that the
  // thing is about to leave, because that is the property the standard behind it turns on.
  send: 'Outward send',
  command: 'Command',
};

/** The label to show for a trigger, falling back to the raw name for one we do not know. */
export function triggerLabel(trigger) {
  return TRIGGER_LABELS[trigger] || trigger;
}

/**
 * Render the reminder line.
 *
 * @param {object}  opts
 * @param {string}  opts.version — client version, for the 【OwnMind vX】 tag
 * @param {string}  opts.trigger — canonical trigger name
 * @param {Record<string, number>} opts.counts — matched rules per memory type
 * @param {boolean} [opts.withHowTo] — append the "how do I read these" line
 * @returns {string} one or two lines, or '' when there is nothing to say
 */
export function renderHookContextLine({
  version, trigger, counts, totals, names, withHowTo = false,
}) {
  const total = HOOK_CONTEXT_TYPES.reduce((n, { type }) => n + (counts?.[type] || 0), 0);
  // Nothing matched in any category: stay quiet. A line saying five zeroes is noise in front
  // of an operation OwnMind has nothing to say about, and this is the existing behaviour of
  // both hooks — worth keeping, since a reminder that appears when it has no content is the
  // fastest way to teach someone to stop reading it.
  if (total === 0) return '';

  // A category at 0 IS printed, once at least one other has something. This looks like it
  // contradicts the edit reminder's "0 rules, say nothing", and does not: that rule is about
  // the total, this is about one row inside a listing that already earned its place. The zero
  // is the informative part — it says the category was looked at and matched nothing, which
  // is precisely what the old line could not distinguish from "never fetched". On an account
  // where only 2 of 14 profile entries carry a trigger tag, that row reads 0 and is telling
  // the truth about the tagging, not hiding a fetch that did not happen.
  // v1.26.154 — `1/32`, not `1`. `totals` is absent on the legacy path, where the fallback
  // endpoint knows the iron-rule count and nothing else; a denominator invented there would
  // claim the other four were counted when they were never fetched, which is the exact
  // confusion this display exists to end. So the bare form stays as the honest degradation.
  const parts = HOOK_CONTEXT_TYPES.map(({ type, label }) => (
    totals
      ? `${label} ${counts?.[type] || 0}/${totals[type] || 0}`
      : `${label} ${counts?.[type] || 0}`
  ));
  const line = `[OwnMind v${version}] This operation is a "${triggerLabel(trigger)}" `
    + `procedure. Memories found: ${parts.join(', ')}`;

  // The instruction that makes the English above reach the user in their own language. Same
  // shape as the startup tip's: say what to relay, and name what must survive the translation.
  // Without it the model either drops the line or paraphrases the numbers away, and the
  // numbers are the entire point — they are what separates "looked, found none" from
  // "never asked".
  const relay = 'Relay the line above to the user, translated into the language you are '
    + 'speaking with them. Keep the counts and the version tag exactly as written.';
  const howTo = ' To show the contents of a category, read it with ownmind_get — e.g. '
    + 'ownmind_get("team_standard") — and tell them they can simply ask for it by name.';

  // v1.26.154 — the names, when the caller has decided this is the once-an-hour listing.
  //
  // Only categories with something in them get a row: a heading followed by nothing is the
  // shape people learn to skip past, and the count above has already said the category was
  // looked at. Callers that print their own iron-rule banner leave `iron_rule` out of `names`
  // rather than have it appear twice — the decision is theirs because only they know whether
  // that banner is about to be printed.
  //
  // No cap on the list. Deliberate, and decided with the numbers on the table: a real account
  // matches around 38 iron rules on a commit. Truncating to the first N would hide the rest
  // behind a "…and 28 more" that nobody can act on, and the window already keeps this to once
  // an hour per trigger, which is what the length is being traded against.
  const listed = names
    ? HOOK_CONTEXT_TYPES
      .filter(({ type }) => (names[type] || []).length > 0)
      .map(({ type, label }) => `  ${label}: ${names[type].join(', ')}`)
    : [];
  const listing = listed.length
    ? `\n${listed.join('\n')}\nThese names are part of the line above — relay them too, `
      + 'translated, and keep each name recognisable.'
    : '';

  return `${line}\n${relay}${withHowTo ? howTo : ''}${listing}`;
}
