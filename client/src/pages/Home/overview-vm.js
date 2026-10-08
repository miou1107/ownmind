/**
 * client/src/pages/Home/overview-vm.js
 *
 * v1.32.2 — the 總覽 page, as data. Takes GET /api/me/overview and produces what the page
 * shows: three lights with one sentence each, the 等你處理 rows, four tiles with one
 * comparison sentence each. Pure, so the sentences are testable without rendering.
 *
 * Two rules from the prototype, enforced here rather than in JSX:
 *   - every status says what the reader should do, or that nothing is needed;
 *   - a number the server does not have renders as 「沒有資料」, never as 0.
 */

const STATES = new Set(['good', 'warn', 'bad', 'none']);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function lightState(raw) {
  return STATES.has(raw) ? raw : 'none';
}

/** `t` is the dictionary function; `n(key, vars)` fills {placeholders}. */
function fill(t, key, vars = {}) {
  let s = t(key);
  for (const [k, v] of Object.entries(vars)) s = s.split(`{${k}}`).join(String(v));
  return s;
}

/**
 * The three lights. Each: { id, state, title, text, action: { label, to } | null }.
 */
export function lightsVm(overview, t, { role } = {}) {
  const L = overview?.lights ?? {};
  const out = [];

  // 記憶主機 — did the AI load memory recently?
  const mem = L.memory ?? {};
  const memState = lightState(mem.state);
  out.push({
    id: 'memory',
    state: memState,
    title: t('home.light.memory'),
    text: memState === 'good' ? t('home.light.memory.good')
      : memState === 'warn' ? t('home.light.memory.warn')
        : t('home.light.memory.none'),
    action: memState === 'good' ? null : { label: t('home.light.memory.action'), to: '/usage/mine' },
  });

  // 用量回報 — is every one of my computers reporting, and to this server?
  const rep = L.reporting ?? {};
  const repState = lightState(rep.state);
  const oldHosts = (rep.machines ?? []).filter((m) => m.on_old_host).map((m) => m.machine);
  const stale = rep.stale_tools ?? [];
  let repText;
  if (repState === 'bad') repText = fill(t, 'home.light.reporting.bad', { machines: oldHosts.join('、') });
  else if (repState === 'warn') repText = fill(t, 'home.light.reporting.warn', { tools: stale.join('、') });
  else if (repState === 'good') repText = t('home.light.reporting.good');
  else repText = t('home.light.reporting.none');
  out.push({
    id: 'reporting',
    state: repState,
    title: t('home.light.reporting'),
    text: repText,
    action: repState === 'good' ? null : { label: t('home.light.reporting.action'), to: '/usage/mine' },
  });

  // 規矩檢查 — were the checks reported back?
  const rules = L.rules ?? {};
  const rulesState = lightState(rules.state);
  let rulesText;
  if (rulesState === 'none') rulesText = fill(t, 'home.light.rules.none', { days: overview?.range_days ?? 7 });
  else if (rulesState === 'warn') rulesText = fill(t, 'home.light.rules.warn', { days: overview?.range_days ?? 7, n: rules.unverified ?? 0 });
  else rulesText = fill(t, 'home.light.rules.good', { days: overview?.range_days ?? 7 });
  out.push({
    id: 'rules',
    state: rulesState,
    title: t('home.light.rules'),
    text: rulesText,
    action: rulesState === 'warn' ? { label: t('home.light.rules.action'), to: '/usage/rules' } : null,
  });

  void role;
  return out;
}

/**
 * 等你處理 rows: { id, text, detail, to, action }. Empty when nothing waits.
 */
export function pendingVm(overview, t) {
  const P = overview?.pending ?? {};
  // v1.32.8 — the lists are capped previews; the server's counts say how many really wait.
  const C = P.counts ?? {};
  const n = (key, list) => (isNum(C[key]) ? C[key] : list.length);
  const rows = [];
  const handoffs = P.handoffs ?? [];
  if (n('handoffs', handoffs)) {
    rows.push({
      id: 'handoffs',
      text: fill(t, 'home.pending.handoffs', { n: n('handoffs', handoffs) }),
      detail: handoffs.map((h) => h.from_tool
        ? fill(t, 'home.pending.handoff_item', { project: h.project ?? '—', tool: h.from_tool, machine: h.from_machine ?? '—' })
        : (h.project ?? '—')).join('、'),
      to: '/inbox/handoffs',
      action: t('home.pending.handoffs.action'),
    });
  }
  const lessons = P.lessons ?? [];
  if (n('lessons', lessons)) {
    rows.push({
      id: 'lessons',
      text: fill(t, 'home.pending.lessons', { n: n('lessons', lessons) }),
      detail: [...new Set(lessons.map((l) => l.project).filter(Boolean))].join('、'),
      to: '/inbox/lessons',
      action: t('home.pending.lessons.action'),
    });
  }
  const tasks = P.tasks ?? [];
  if (n('tasks', tasks)) {
    rows.push({
      id: 'tasks',
      text: fill(t, 'home.pending.tasks', { n: n('tasks', tasks) }),
      detail: tasks.map((x) => x.title).join('、'),
      to: '/inbox/tasks',
      action: t('home.pending.tasks.action'),
    });
  }
  const bugs = P.bugs;   // null for a member: not theirs to handle
  if (Array.isArray(bugs) && n('bugs', bugs)) {
    rows.push({
      id: 'bugs',
      text: fill(t, 'home.pending.bugs', { n: n('bugs', bugs) }),
      detail: bugs.map((b) => (b.reporter_name ? `${b.reporter_name}：${b.title}` : b.title)).join('、'),
      to: '/inbox/bugs',
      action: t('home.pending.bugs.action'),
    });
  }
  return rows;
}

/** 「沒有資料」 when the server has no value; otherwise the number as a string. */
export function numberOrNoData(v, t) {
  return isNum(v) ? String(v) : t('home.no_data');
}

/**
 * The four tiles: { id, label, value, unit, note, tone }. `tone` is up/down/flat/none.
 */
export function tilesVm(overview, t, { role } = {}) {
  const T = overview?.tiles ?? {};
  const days = overview?.range_days ?? 7;
  const out = [];

  const s = T.sessions ?? {};
  if (isNum(s.current)) {
    const diff = isNum(s.previous) ? s.current - s.previous : null;
    out.push({
      id: 'sessions',
      label: t('home.tile.sessions'),
      value: String(s.current),
      unit: t('home.unit.sessions'),
      note: diff === null ? t('home.no_previous')
        : diff === 0 ? fill(t, 'home.tile.sessions.same', { days })
          : fill(t, diff > 0 ? 'home.tile.sessions.more' : 'home.tile.sessions.less', { days, n: Math.abs(diff) }),
      tone: diff === null || diff === 0 ? 'flat' : diff > 0 ? 'up' : 'down',
    });
  } else {
    out.push({ id: 'sessions', label: t('home.tile.sessions'), value: t('home.no_data'), unit: '', note: t('home.tile.sessions.none'), tone: 'none' });
  }

  const c = T.compliance ?? {};
  if (isNum(c.rate)) {
    const pct = Math.round(c.rate * 100);
    const prev = isNum(c.previous_rate) ? Math.round(c.previous_rate * 100) : null;
    const d = prev === null ? null : pct - prev;
    const worst = c.worst_rule?.title ? fill(t, 'home.tile.compliance.worst', { rule: c.worst_rule.title }) : '';
    out.push({
      id: 'compliance',
      label: t('home.tile.compliance'),
      value: `${pct}%`,
      unit: '',
      note: [
        d === null ? t('home.no_previous')
          : d === 0 ? fill(t, 'home.tile.compliance.same', { days })
            : fill(t, d > 0 ? 'home.tile.compliance.higher' : 'home.tile.compliance.lower', { days, n: Math.abs(d) }),
        worst,
      ].filter(Boolean).join('，'),
      tone: d === null || d === 0 ? 'flat' : d > 0 ? 'up' : 'down',
    });
  } else {
    out.push({ id: 'compliance', label: t('home.tile.compliance'), value: t('home.no_data'), unit: '', note: t('home.tile.compliance.none'), tone: 'none' });
  }

  const p = T.top_project;
  if (p?.project) {
    out.push({
      id: 'project',
      label: t('home.tile.project'),
      value: p.project,
      unit: '',
      note: fill(t, 'home.tile.project.note', { sessions: p.sessions ?? 0, handoffs: p.handoffs ?? 0 }),
      tone: 'flat',
      small: true,
    });
  } else {
    out.push({ id: 'project', label: t('home.tile.project'), value: t('home.no_data'), unit: '', note: fill(t, 'home.tile.project.none', { days }), tone: 'none' });
  }

  const isAdmin = role === 'admin' || role === 'super_admin';
  const tv = T.team_visible;
  if (isAdmin && tv && isNum(tv.visible) && isNum(tv.total)) {
    const missing = tv.invisible_names ?? [];
    out.push({
      id: 'team',
      label: t('home.tile.team'),
      value: `${tv.visible}／${tv.total}`,
      unit: t('home.unit.people'),
      note: missing.length ? fill(t, 'home.tile.team.missing', { names: missing.join('、') }) : t('home.tile.team.all'),
      tone: missing.length ? 'down' : 'flat',
    });
  } else {
    const la = T.last_activity;
    out.push(la?.ts ? {
      id: 'last',
      label: t('home.tile.last'),
      value: la.ts,                       // the page formats the time
      unit: '',
      note: [la.tool, la.project].filter(Boolean).join('，') || t('home.tile.last.no_detail'),
      tone: 'flat',
      small: true,
      isTime: true,
    } : { id: 'last', label: t('home.tile.last'), value: t('home.no_data'), unit: '', note: t('home.tile.last.none'), tone: 'none' });
  }

  return out;
}

/** Daily rows for DailyChart: `[{ date, count }]`, chronological, from the server's list. */
export function dailyVm(overview) {
  const d = overview?.daily;
  if (!Array.isArray(d)) return [];
  return d.map((r) => ({ date: String(r.date ?? ''), count: Number(r.count) || 0 }));
}
