/**
 * Pick the rules worth judging this turn.
 *
 * This is the most fragile part of the feature. A rule that is not selected is a rule that
 * is not enforced, and it fails silently: "nothing was selected" looks exactly like a quiet,
 * correct turn. So the bias is deliberately towards over-selection, with a token budget as
 * the only limit rather than a relevance threshold, and the caller records what was
 * considered - because "never selected" and "selected and misjudged" need different fixes
 * and are indistinguishable afterwards otherwise.
 */

const DEFAULT_MAX_RULES = 6;
const DEFAULT_MAX_CHARS = 20_000;

/** Summary layer plus every fragment. A prohibition list often lives in a fragment. */
function buildJudgeText(rule) {
  const parts = [rule.content || ''];
  if (Array.isArray(rule.fragments)) {
    for (const fragment of rule.fragments) {
      if (!fragment) continue;
      const heading = fragment.title ? `\n\n## ${fragment.title}\n` : '\n\n';
      parts.push(heading + (fragment.content || ''));
    }
  }
  return parts.join('').trim();
}

function haystack(context) {
  return [
    context.assistantText || '',
    ...(Array.isArray(context.userPrompts) ? context.userPrompts : []),
  ].join('\n').toLowerCase();
}

function matchesKeyword(rule, hay) {
  const keywords = rule?.metadata?.enforcement?.keywords;
  if (!Array.isArray(keywords)) return false;
  return keywords.some((k) => typeof k === 'string' && k && hay.includes(k.toLowerCase()));
}

function matchesRepo(rule, repoRemote) {
  const repoMatch = rule?.metadata?.enforcement?.guard?.repo_match;
  if (!repoMatch || typeof repoRemote !== 'string' || !repoRemote) return false;
  return repoRemote.includes(repoMatch);
}

/**
 * The trigger tags a rule already carries.
 *
 * This is what brings in the rules nobody has annotated - which on day one is nearly all of
 * them. Without it the judge would cover only the handful with an enforcement block, and the
 * instruction was every rule.
 */
// v1.26.171: the hook sends trigger as an array (a reply is both a respond and a report).
// The old template string turned that array into "trigger:respond,report", which matches no
// tag — measured on the live bundle, 6 of 310 rules were ever judged. Any element may match.
function matchesTag(rule, trigger) {
  if (!trigger || !Array.isArray(rule?.tags)) return false;
  const triggers = Array.isArray(trigger) ? trigger : [trigger];
  return triggers.some((t) => t && rule.tags.includes(`trigger:${t}`));
}

/** trigger:always is a standing instruction, not a contextual match — ranked with always_check. */
function isAlwaysTagged(rule) {
  return Array.isArray(rule?.tags) && rule.tags.includes('trigger:always');
}

/**
 * @param {Array<object>} memories
 * @param {{assistantText?: string, userPrompts?: string[], repoRemote?: string|null,
 *          toolsUsed?: string[], trigger?: string|string[]}} context
 * @param {{maxRules?: number, maxChars?: number}} [opts]
 * @returns {{selected: Array<object>, budgetExceeded: boolean}}
 */
export function selectRules(memories, context = {}, opts = {}) {
  const maxRules = opts.maxRules ?? DEFAULT_MAX_RULES;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (!Array.isArray(memories) || memories.length === 0) {
    // Same shape as every other return. An early exit that omits a field the caller reads is
    // a TypeError that only fires for the account with no rules yet - the one population
    // least likely to report it.
    return { selected: [], dropped: [], budgetExceeded: false };
  }

  const hay = haystack(context);
  const repoRemote = context.repoRemote || null;
  const trigger = context.trigger || '';

  // Ranked, not filtered: anything that matches at all is a candidate, and only the budget
  // removes any of them.
  const candidates = [];
  for (const rule of memories) {
    if (!rule) continue;
    let rank = null;
    if (rule?.metadata?.enforcement?.always_check === true || isAlwaysTagged(rule)) rank = 0;
    else if (matchesRepo(rule, repoRemote)) rank = 1;
    else if (matchesKeyword(rule, hay)) rank = 2;
    else if (matchesTag(rule, trigger)) rank = 3;
    if (rank === null) continue;
    candidates.push({ rank, rule });
  }

  candidates.sort((a, b) => a.rank - b.rank || (a.rule.id || 0) - (b.rule.id || 0));

  const selected = [];
  const dropped = [];
  let chars = 0;
  for (const { rank, rule } of candidates) {
    // The count budget is a hard stop for contextual matches. Rank-0 rules (always_check /
    // trigger:always) are exempt from it: a standing instruction the user marked "every
    // turn" being silently evicted by the count of its siblings is exactly the
    // rule-delivered-but-not-enforced failure this module exists to prevent. The char
    // budget below still applies to them — an oversized rule set has to lose something,
    // and that loss is at least recorded.
    if (rank !== 0 && selected.length >= maxRules) {
      dropped.push(rule.id);
      continue;
    }
    const judgeText = buildJudgeText(rule);
    // The character budget skips this rule and keeps going, rather than ending the loop.
    // Stopping would let one oversized rule silently take every rule after it out of scope,
    // and the only visible symptom would be a turn that reported nothing to check.
    if (chars + judgeText.length > maxChars) {
      dropped.push(rule.id);
      continue;
    }
    chars += judgeText.length;
    selected.push({ ...rule, judgeText });
  }

  // `dropped` is returned so the caller can record it. A rule that was relevant and did not
  // fit is a coverage gap, and one that is never written down is one nobody can act on.
  return { selected, dropped, budgetExceeded: dropped.length > 0 };
}
