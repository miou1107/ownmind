/**
 * client/src/pages/Home/overview-vm.js
 *
 * 總覽, as data. Takes GET /api/me/overview and produces what the page shows, top to bottom:
 *   1. one headline sentence about the period, naming the things worth a look;
 *   2. 「AI 守規矩」: the rate, the previous period, the three rules missed most;
 *   3. 「同事用得怎樣」 (admin): one row per teammate with a plain verdict;
 *   4. 「要你決定的事」: at most five recent items, one sentence each;
 *   5. a small footer line: memory and computers, red or yellow only when something is off.
 * Pure, so the sentences are testable without rendering.
 *
 * Rules kept here rather than in JSX:
 *   - a number the server does not have renders as 「沒有資料」, never as 0 or 100%;
 *   - every sentence says what the reader should do, or that nothing is needed.
 */

const STATES = new Set(['good', 'warn', 'bad', 'none']);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const pctOf = (rate) => (isNum(rate) ? Math.round(rate * 100) : null);

/** Below this a teammate "often forgets the rules". */
export const LOW_RATE = 0.8;
/** At or above this a teammate can be called out as doing well. */
export const GOOD_RATE = 0.9;
/** How many decisions the home page lists. */
export const MAX_DECISIONS = 5;

export function lightState(raw) {
  return STATES.has(raw) ? raw : 'none';
}

/** `t` is the dictionary function; fill() puts values into its {placeholders}. */
function fill(t, key, vars = {}) {
  let s = t(key);
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/** 「這週／上週」 for 7 days, 「這 N 天／前 N 天」 otherwise. */
export function periodWords(days, t) {
  const n = isNum(days) ? days : 7;
  return n === 7
    ? { cur: t('home.period.this_week'), prev: t('home.period.last_week') }
    : { cur: fill(t, 'home.period.this_days', { n }), prev: fill(t, 'home.period.prev_days', { n }) };
}

/** 「沒有資料」 when the server has no value; otherwise the number as a string. */
export function numberOrNoData(v, t) {
  return isNum(v) ? String(v) : t('home.no_data');
}

// ── 2. AI 守規矩 ─────────────────────────────────────────────

/**
 * {
 *   value: '95%' | 沒有資料, hasData,
 *   compare: '上週是 100%' | '上週沒有資料可比',
 *   badge: { kind: better|worse|same, text } | null,
 *   sentence, top: [{ code, title, text }], empty: string | null, footnote: string | null
 * }
 */
export function rulesVm(overview, t) {
  const R = overview?.rules ?? {};
  const { prev } = periodWords(overview?.range_days, t);
  const pct = pctOf(R.rate);
  const prevPct = pctOf(R.previous_rate);
  const unreported = isNum(R.unreported) && R.unreported > 0
    ? fill(t, 'home.rules.unreported', { n: R.unreported })
    : null;

  if (pct === null) {
    return {
      hasData: false,
      value: t('home.no_data'),
      compare: '',
      badge: null,
      sentence: t('home.rules.none'),
      top: [],
      empty: null,
      footnote: unreported,
    };
  }

  const diff = prevPct === null ? null : pct - prevPct;
  const badge = diff === null ? null
    : diff > 0 ? { kind: 'better', text: fill(t, 'home.rules.badge.better', { prev }) }
      : diff < 0 ? { kind: 'worse', text: fill(t, 'home.rules.badge.worse', { prev }) }
        : { kind: 'same', text: fill(t, 'home.rules.badge.same', { prev }) };

  const total = isNum(R.total) ? R.total : 0;
  const missed = isNum(R.missed) ? R.missed : 0;
  const sentence = missed === 0
    ? fill(t, 'home.rules.sentence.all', { total })
    : fill(t, 'home.rules.sentence', { total, missed });

  const top = (R.top_missed ?? [])
    .filter((r) => isNum(r?.missed) && r.missed > 0)
    .slice(0, 3)
    .map((r) => ({
      code: r.code ?? null,
      title: r.title || fill(t, 'home.rules.untitled', { code: r.code ?? '' }),
      text: fill(t, 'home.rules.missed_times', { n: r.missed }),
    }));

  return {
    hasData: true,
    value: `${pct}%`,
    compare: prevPct === null
      ? fill(t, 'home.rules.compare.none', { prev })
      : fill(t, 'home.rules.compare', { prev, pct: prevPct }),
    badge,
    sentence,
    top,
    empty: top.length === 0 ? t('home.rules.top.empty') : null,
    footnote: unreported,
  };
}

// ── 3. 同事用得怎樣 ───────────────────────────────────────────

const TONE_ORDER = { danger: 0, warning: 1, success: 2, muted: 3 };

/**
 * One row per teammate, problems first: { id, name, rate, sessions, verdict, tone }.
 * `tone` is success | warning | danger | muted. null when the caller does not see the team.
 */
export function teamVm(overview, t) {
  const T = overview?.team;
  if (!Array.isArray(T)) return null;
  const { cur } = periodWords(overview?.range_days, t);

  // Who to praise: the most conversations, and the best rate among the rest. Only people
  // who are doing well get a compliment, and only one each.
  const active = T.filter((p) => !p.inactive_14d && isNum(p.sessions) && p.sessions > 0);
  const topUser = [...active].sort((a, b) => b.sessions - a.sessions)[0];
  const mostUsedId = topUser && isNum(topUser.rate) && topUser.rate >= GOOD_RATE ? topUser.user_id : null;
  const best = active
    .filter((p) => p.user_id !== mostUsedId && isNum(p.rate) && p.rate >= GOOD_RATE)
    .sort((a, b) => b.rate - a.rate || b.sessions - a.sessions)[0];
  const bestId = best ? best.user_id : null;

  const rows = T.map((p) => {
    const sessions = isNum(p.sessions) ? p.sessions : 0;
    let verdict; let tone;
    if (p.inactive_14d) {
      verdict = p.last_active_at ? t('home.team.verdict.inactive') : t('home.team.verdict.never');
      tone = 'danger';
    } else if (isNum(p.rate) && p.rate < LOW_RATE) {
      verdict = t('home.team.verdict.forgets');
      tone = 'warning';
    } else if (p.user_id === mostUsedId) {
      verdict = t('home.team.verdict.most_used');
      tone = 'success';
    } else if (p.user_id === bestId) {
      verdict = t('home.team.verdict.best');
      tone = 'success';
    } else if (sessions === 0) {
      verdict = fill(t, 'home.team.verdict.idle', { period: cur });
      tone = 'muted';
    } else if (!isNum(p.rate)) {
      verdict = t('home.team.verdict.no_score');
      tone = 'muted';
    } else {
      verdict = t('home.team.verdict.ok');
      tone = 'muted';
    }
    return {
      id: p.user_id,
      name: p.is_me ? fill(t, 'home.team.me', { name: p.name }) : p.name,
      rawName: p.name,
      isMe: Boolean(p.is_me),
      rate: isNum(p.rate) ? `${pctOf(p.rate)}%` : t('home.no_data'),
      sessions: fill(t, 'home.team.sessions', { n: sessions }),
      sessionCount: sessions,
      verdict,
      tone,
    };
  });

  return rows.sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone]
    || b.sessionCount - a.sessionCount
    || String(a.rawName).localeCompare(String(b.rawName)));
}

// ── 4. 要你決定的事 ───────────────────────────────────────────

/**
 * { count, items: [{ id, text, to }], more: string | null, note, empty }
 * `count` is every recent decision; `items` is the newest MAX_DECISIONS of them.
 */
export function decisionsVm(overview, t) {
  const D = overview?.decisions ?? {};
  const days = isNum(D.recent_days) ? D.recent_days : 7;
  const all = [];

  const lessons = D.lessons ?? {};
  if (isNum(lessons.count) && lessons.count > 0) {
    all.push({
      id: 'lessons',
      text: fill(t, 'home.decide.lessons', { n: lessons.count }),
      to: '/inbox/lessons',
      ts: lessons.latest_at,
    });
  }
  for (const b of D.bugs ?? []) {
    all.push({
      id: `bug-${b.id}`,
      text: b.reporter_name
        ? fill(t, 'home.decide.bug', { name: b.reporter_name, title: b.title })
        : fill(t, 'home.decide.bug.anon', { title: b.title }),
      to: '/inbox/bugs',
      ts: b.updated_at,
    });
  }
  for (const h of D.handoffs ?? []) {
    const n = isNum(h.count) ? h.count : 1;
    all.push({
      id: `handoff-${h.project ?? ''}`,
      text: !h.project ? fill(t, 'home.decide.handoff.no_project', { n })
        : n === 1 ? fill(t, 'home.decide.handoff', { project: h.project })
          : fill(t, 'home.decide.handoffs', { project: h.project, n }),
      to: '/inbox/handoffs',
      ts: h.latest_at,
    });
  }
  for (const x of D.tasks ?? []) {
    all.push({
      id: `task-${x.id}`,
      text: fill(t, 'home.decide.task', { title: x.title }),
      to: '/inbox/tasks',
      ts: x.done_at,
    });
  }

  // Tasks and bugs beyond the five the server listed still count.
  const extraTasks = Math.max(0, (isNum(D.tasks_count) ? D.tasks_count : 0) - (D.tasks ?? []).length);
  const extraBugs = Math.max(0, (isNum(D.bugs_count) ? D.bugs_count : 0) - (D.bugs ?? []).length);
  const count = all.length + extraTasks + extraBugs;

  const time = (v) => { const n = new Date(v ?? 0).getTime(); return Number.isFinite(n) ? n : 0; };
  const items = all
    .sort((a, b) => time(b.ts) - time(a.ts))
    .slice(0, MAX_DECISIONS)
    .map(({ id, text, to }) => ({ id, text, to }));

  const left = count - items.length;
  const hidden = isNum(D.hidden) ? D.hidden : 0;
  return {
    count,
    items,
    more: left > 0 ? fill(t, 'home.decide.more', { n: left }) : null,
    note: hidden > 0
      ? fill(t, 'home.decide.hidden', { n: hidden, days })
      : fill(t, 'home.decide.hidden.none', { days }),
    empty: fill(t, 'home.decide.empty', { days }),
  };
}

// ── 5. footer ───────────────────────────────────────────────

/** Two short items: { id, state, text, action: { label, to } | null }. */
export function footerVm(overview, t) {
  const L = overview?.lights ?? {};
  const out = [];

  const memState = lightState(L.memory?.state);
  out.push({
    id: 'memory',
    state: memState,
    text: memState === 'good' ? t('home.footer.memory.good')
      : memState === 'warn' ? t('home.light.memory.warn')
        : t('home.light.memory.none'),
    action: memState === 'good' ? null : { label: t('home.light.memory.action'), to: '/usage/mine' },
  });

  const rep = L.reporting ?? {};
  const repState = lightState(rep.state);
  const oldHosts = (rep.machines ?? []).filter((m) => m.on_old_host).map((m) => m.machine);
  let repText;
  if (repState === 'bad') repText = fill(t, 'home.light.reporting.bad', { machines: oldHosts.join('、') });
  else if (repState === 'warn') repText = fill(t, 'home.light.reporting.warn', { tools: (rep.stale_tools ?? []).join('、') });
  else if (repState === 'good') repText = t('home.footer.reporting.good');
  else repText = t('home.light.reporting.none');
  out.push({
    id: 'reporting',
    state: repState,
    text: repText,
    action: repState === 'good' ? null : { label: t('home.light.reporting.action'), to: '/usage/mine' },
  });

  return out;
}

// ── 1. headline ─────────────────────────────────────────────

/**
 * { title, detail }. The things worth a look, named in one line: compliance falling,
 * teammates who stopped or often forget, a computer or memory not working.
 */
export function headlineVm(overview, t) {
  const { cur, prev } = periodWords(overview?.range_days, t);
  const concerns = [];

  const pct = pctOf(overview?.rules?.rate);
  const prevPct = pctOf(overview?.rules?.previous_rate);
  if (pct !== null && prevPct !== null && pct < prevPct) {
    concerns.push(fill(t, 'home.headline.rules_worse', { prev }));
  }

  const team = Array.isArray(overview?.team) ? overview.team.filter((p) => !p.is_me) : [];
  const gone = team.filter((p) => p.inactive_14d && p.last_active_at).map((p) => p.name);
  if (gone.length) concerns.push(fill(t, 'home.headline.inactive', { names: gone.join('、') }));
  const never = team.filter((p) => p.inactive_14d && !p.last_active_at).map((p) => p.name);
  if (never.length) concerns.push(fill(t, 'home.headline.never', { names: never.join('、') }));
  const forget = team.filter((p) => !p.inactive_14d && isNum(p.rate) && p.rate < LOW_RATE).map((p) => p.name);
  if (forget.length) concerns.push(fill(t, 'home.headline.forgets', { names: forget.join('、') }));

  const L = overview?.lights ?? {};
  if (lightState(L.memory?.state) === 'warn') concerns.push(t('home.headline.memory'));
  const rep = lightState(L.reporting?.state);
  if (rep === 'bad' || rep === 'warn') concerns.push(t('home.headline.reporting'));

  const n = concerns.length;
  // Nothing wrong because nothing arrived is not "all normal": the lights would be grey.
  const nothingYet = n === 0 && pct === null && lightState(L.memory?.state) === 'none';
  if (nothingYet) return { title: fill(t, 'home.headline.no_data', { period: cur }), detail: '', count: 0 };
  const title = n === 0 ? fill(t, 'home.headline.ok', { period: cur })
    : n <= 2 ? fill(t, 'home.headline.mostly_ok', { period: cur, n })
      : fill(t, 'home.headline.many', { period: cur, n });
  return { title, detail: n ? concerns.join('；') : '', count: n };
}
