/**
 * v1.33.4 — the issues, PRs and MRs waiting on the user, across every repository (issue #203).
 *
 * Collectors ask GitHub (through the `gh` CLI the user is already signed in to) and each
 * GitLab host listed in ~/.ownmind/git-hosts.json. `decide` turns their answers into what is
 * new since the last list shown today, and `render` turns that into the lines the user sees.
 * The state file also holds the full current list, which the desktop pane reads.
 *
 * Every function here fails closed to "nothing to say": a reminder that cannot be computed must
 * never cost the session its start or its turn.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { localDateOnly, localIsoTimestamp } from '../../shared/local-date.js';
import { readCredentials } from '../../shared/helpers.js';

export const HOST_TIMEOUT_MS = 2500;
export const MAX_LINES = 10;
// The whole check, every host together. The macOS session-start script runs under `timeout 5`
// and writes its only output after this resolves; a slow host must not cost the session its
// context.
export const TOTAL_BUDGET_MS = 2500;
export const RECHECK_MINUTES = 60;
const MAX_PER_SEARCH = 30;
const MAX_FAILING_LOOKUPS = 10;

export function defaultStatePath(home = os.homedir()) {
  return path.join(home, '.ownmind', 'state', 'pending-items.json');
}

export function defaultHostsPath(home = os.homedir()) {
  return path.join(home, '.ownmind', 'git-hosts.json');
}

// ---------------------------------------------------------------------------------------------
// GitHub

const GH_QUERY = `query {
  viewer { login }
  assigned: search(query: "is:open is:issue assignee:@me archived:false", type: ISSUE, first: ${MAX_PER_SEARCH}) {
    nodes { ... on Issue { number title url updatedAt author { __typename login ... on User { name } } repository { nameWithOwner } } }
  }
  review: search(query: "is:open is:pr review-requested:@me archived:false", type: ISSUE, first: ${MAX_PER_SEARCH}) {
    nodes { ... on PullRequest { number title url updatedAt author { __typename login ... on User { name } } repository { nameWithOwner } } }
  }
  authored: search(query: "is:open is:pr author:@me archived:false", type: ISSUE, first: ${MAX_PER_SEARCH}) {
    nodes { ... on PullRequest { number title url updatedAt repository { nameWithOwner }
      comments(last: 10) { nodes { createdAt author { __typename login ... on User { name } } } }
      reviews(last: 10) { nodes { submittedAt author { __typename login ... on User { name } } } }
      commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } } } }
  }
}`;

// A hook may run with a shorter PATH than the user's shell; try the usual install places too.
const GH_CANDIDATES = ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', 'C:\\Program Files\\GitHub CLI\\gh.exe'];

/** Runs `gh` with a hard timeout. Never rejects. */
export async function runGh(args, timeoutMs = HOST_TIMEOUT_MS) {
  let last = { code: -1, error: 'ENOENT', stdout: '', stderr: '' };
  for (const bin of GH_CANDIDATES) {
    last = await runGhAt(bin, args, timeoutMs);
    if (last.error !== 'ENOENT') return last;
  }
  return last;
}

function runGhAt(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve({ code: -1, error: err?.code || 'spawn', stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: -1, error: 'timeout', stdout, stderr });
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => finish({ code: -1, error: err?.code || 'spawn', stdout, stderr }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

function ghStatusOf(res) {
  if (res.error === 'ENOENT') return 'absent';
  if (res.error) return 'error';
  const err = String(res.stderr || '');
  if (/HTTP 401|Bad credentials|token .*(expired|revoked|invalid)/i.test(err)) return 'refused';
  if (/gh auth login|not logged in/i.test(err)) return 'absent';
  return 'error';
}

export async function collectGithub({ run = runGh, timeoutMs = HOST_TIMEOUT_MS } = {}) {
  const host = 'github';
  const res = await run(['api', 'graphql', '-f', `query=${GH_QUERY}`], timeoutMs);
  // gh exits non-zero when any part of the query errors (an organisation that needs SSO, say),
  // yet still prints what it could read. Use that; only a reply with no data is a failure.
  let data = null;
  try { data = JSON.parse(res.stdout || '').data || null; } catch { data = null; }
  if (!data) return { host, status: res.code === 0 ? 'error' : ghStatusOf(res), items: [] };
  const me = data.viewer?.login || '';

  const items = [];
  const commentMarks = {};
  const commentWho = {};
  const authoredMeta = {};
  const base = (n) => ({
    key: `github:${n.repository?.nameWithOwner}#${n.number}`,
    title: n.title,
    url: n.url,
    at: n.updatedAt,
    // The side pane groups cards by project; on GitHub that is the repository's name.
    project: String(n.repository?.nameWithOwner || '').split('/').pop() || '',
  });
  for (const n of data.assigned?.nodes || []) {
    if (!n?.number) continue;
    // The card shows who is waiting: whoever opened the issue, unless that was the user.
    const opener = n.author?.login && n.author.login !== me ? personName(n.author) : '';
    items.push({ ...base(n), kind: 'assigned', signal: '', ref: `${n.repository?.nameWithOwner} issue #${n.number}`, person: opener });
  }
  for (const n of data.review?.nodes || []) {
    if (!n?.number) continue;
    items.push({ ...base(n), kind: 'review', signal: '', ref: `${n.repository?.nameWithOwner} PR #${n.number}`, who: n.author?.login || '', person: personName(n.author) });
  }
  for (const n of data.authored?.nodes || []) {
    if (!n?.number) continue;
    const b = { ...base(n), ref: `${n.repository?.nameWithOwner} PR #${n.number}` };
    const latest = latestOther([
      ...(n.comments?.nodes || []).map((c) => ({ at: c?.createdAt, who: ghWho(c?.author), name: personName(c?.author) })),
      ...(n.reviews?.nodes || []).map((c) => ({ at: c?.submittedAt, who: ghWho(c?.author), name: personName(c?.author) })),
    ], (who) => who === me);
    commentMarks[b.key] = latest.at;
    if (latest.name) commentWho[b.key] = latest.name;
    authoredMeta[b.key] = { title: b.title, url: b.url, ref: b.ref, project: b.project };
    const commit = n.commits?.nodes?.[0]?.commit;
    const state = commit?.statusCheckRollup?.state;
    if (state === 'FAILURE' || state === 'ERROR') items.push({ ...b, kind: 'failing', signal: commit?.oid || '' });
  }
  return { host, status: 'ok', items, commentMarks, commentWho, authoredMeta };
}

/**
 * A person's display name, falling back to their login; '' for nobody and for bots. GitHub's
 * GraphQL names a bot `dependabot`, not `dependabot[bot]`, so its __typename is what tells.
 */
export function personName(a) {
  if (!a || a.__typename === 'Bot' || a.bot === true || isBotLogin(a.login || a.username || '')) return '';
  for (const v of [a.name, a.login, a.username]) {
    const t = typeof v === 'string' ? v.trim() : '';
    if (t) return t;
  }
  return '';
}

// REST logins end in [bot]; GitLab's project and group access tokens are users named
// project_42_bot_<hash> or group_7_bot_<hash>.
function isBotLogin(login) {
  return /\[bot\]$|-bot$|(^|_)bot(_|$)/i.test(String(login));
}

// Who wrote a GitHub comment, as latestOther expects it: a bot is marked so it is skipped.
function ghWho(a) {
  return a?.__typename === 'Bot' ? 'x-bot' : a?.login;
}

/**
 * The newest comment someone else wrote: its time and its author's name, or '' for both. The
 * user's own replies and bots do not count: a reply to the reviewer is not something waiting
 * on the user.
 */
export function latestOther(entries, isMe) {
  let latest = { at: '', name: '' };
  for (const e of entries) {
    if (!e?.at || !e.who || isMe(e.who) || isBotLogin(e.who)) continue;
    if (e.at > latest.at) latest = { at: e.at, name: e.name || '' };
  }
  return latest;
}

/** The time of the newest comment someone else wrote, or '' when there is none. */
export function latestFromOthers(entries, isMe) {
  return latestOther(entries, isMe).at;
}

// ---------------------------------------------------------------------------------------------
// GitLab

/** GET with a PRIVATE-TOKEN header and a hard timeout. Never rejects with anything but errors. */
export function gitlabGet(url, token, timeoutMs = HOST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'PRIVATE-TOKEN': token }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// { label: display name } pairs naming which labels stand for a product, for a repository that
// holds several products. Anything that is not a string-to-string pair is dropped.
function labelNames(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([k, n]) => k && typeof n === 'string' && n.trim()).map(([k, n]) => [k, n.trim()]));
}

// The project a GitLab issue or MR belongs to: a product label the host entry names, else the
// repository's own name (the last part of `group/sub/repo#12`).
function gitlabProject(x, projectLabels = {}) {
  for (const l of Array.isArray(x.labels) ? x.labels : []) if (projectLabels[l]) return projectLabels[l];
  const full = String(x.references?.full || '');
  return full.replace(/[#!].*$/, '').split('/').pop() || '';
}

export function readGitHosts(file = defaultHostsPath()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw?.gitlab) ? raw.gitlab : [];
    return list
      .filter((h) => h && typeof h.url === 'string' && h.url.trim() && typeof h.token === 'string' && h.token)
      .map((h) => ({ url: h.url.trim().replace(/\/+$/, ''), token: h.token, projectLabels: labelNames(h.projectLabels) }));
  } catch {
    return [];
  }
}

export async function collectGitlab({ host, fetchJson = gitlabGet, timeoutMs = HOST_TIMEOUT_MS }) {
  const id = `gitlab:${host.url}`;
  const get = async (p) => {
    const r = await fetchJson(`${host.url}${p}`, host.token, timeoutMs);
    if (r.status === 401) { const e = new Error('refused'); e.refused = true; throw e; }
    if (r.status !== 200) throw new Error(`status ${r.status}`);
    return JSON.parse(r.body);
  };
  try {
    const me = await get('/api/v4/user');
    const [assigned, review, authored] = await Promise.all([
      get(`/api/v4/issues?scope=assigned_to_me&state=opened&per_page=${MAX_PER_SEARCH}`),
      get(`/api/v4/merge_requests?scope=all&state=opened&reviewer_id=${me.id}&per_page=${MAX_PER_SEARCH}`),
      get(`/api/v4/merge_requests?scope=created_by_me&state=opened&per_page=${MAX_PER_SEARCH}`),
    ]);
    const items = [];
    const commentMarks = {};
    const commentWho = {};
    const authoredMeta = {};
    const base = (x) => ({
      key: `${id}:${x.references?.full || `${x.project_id}${x.iid}`}`,
      title: x.title,
      url: x.web_url,
      at: x.updated_at,
      ref: x.references?.full || String(x.iid),
      project: gitlabProject(x, host.projectLabels),
    });
    for (const x of Array.isArray(assigned) ? assigned : []) {
      const opener = x.author && x.author.id !== me.id ? personName(x.author) : '';
      items.push({ ...base(x), kind: 'assigned', signal: '', person: opener });
    }
    // GitLab lets the author list themself as a reviewer; their own MR names nobody.
    for (const x of Array.isArray(review) ? review : []) items.push({ ...base(x), kind: 'review', signal: '', who: x.author?.username || '', person: x.author && x.author.id !== me.id ? personName(x.author) : '' });
    const mine = Array.isArray(authored) ? authored : [];
    // The list endpoint carries neither the pipeline nor who wrote the notes; ask for the first
    // few MRs one by one, both questions at once.
    const looked = mine.slice(0, MAX_FAILING_LOOKUPS);
    const [detail, notes] = await Promise.all([
      Promise.all(looked.map((x) => get(`/api/v4/projects/${x.project_id}/merge_requests/${x.iid}`).catch(() => null))),
      Promise.all(looked.map((x) => get(`/api/v4/projects/${x.project_id}/merge_requests/${x.iid}/notes?sort=desc&order_by=created_at&per_page=20`).catch(() => null))),
    ]);
    looked.forEach((x, i) => {
      const b = base(x);
      authoredMeta[b.key] = { title: b.title, url: b.url, ref: b.ref, project: b.project };
      if (Array.isArray(notes[i])) {
        const latest = latestOther(
          notes[i].filter((n) => !n?.system).map((n) => ({ at: n.created_at, who: n.author?.bot || isBotLogin(n.author?.username || '') ? 'x-bot' : String(n.author?.id ?? ''), name: personName(n.author) })),
          (who) => who === String(me.id),
        );
        commentMarks[b.key] = latest.at;
        if (latest.name) commentWho[b.key] = latest.name;
      }
      const p = detail[i]?.head_pipeline;
      if (p?.status === 'failed') items.push({ ...b, kind: 'failing', signal: p.sha || x.sha || '' });
    });
    return { host: id, status: 'ok', items, commentMarks, commentWho, authoredMeta };
  } catch (err) {
    return { host: id, status: err?.refused ? 'refused' : 'error', items: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// OwnMind itself: the user's task cards and bug reports. These go to the side pane only and are
// never listed as new in the conversation: the session start already speaks about bug reports and
// this project's task cards, and a card in another project is something to look at, not news.

// A task project can be any name; this one cannot be, since project names never start with '#'.
export const OWNMIND_BUG_PROJECT = '#reports';
// A report the user has not opened stays "resolved" on the server until they mark it read, which
// nothing on the console does yet; the pane shows it for a week, then lets it go.
const RESOLVED_SHOWN_DAYS = 7;

/** GET with a Bearer key and a hard timeout. */
function ownmindGet(url, apiKey, timeoutMs = HOST_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { Authorization: `Bearer ${apiKey}` }, timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * The user's open task cards (every project; not one someone else has taken) and bug reports:
 * the unhandled ones for an admin, and the user's own reports resolved in the last week. A card
 * opens the console page that lists it. If any request fails the whole host is an error, so the
 * cards from the last check stay in the pane, marked stale, rather than half of them vanishing.
 */
export async function collectOwnMind({ apiUrl, apiKey, fetchJson = ownmindGet, timeoutMs = HOST_TIMEOUT_MS, now = new Date() }) {
  const host = 'ownmind';
  if (!apiUrl || !apiKey) return { host, status: 'absent', items: [] };
  const base = String(apiUrl).replace(/\/+$/, '');
  const consoleUrl = `${base}/dashboard`;
  const getJson = async (p) => {
    const r = await fetchJson(`${base}${p}`, apiKey, timeoutMs);
    return { status: r.status, data: r.status === 200 ? JSON.parse(r.body) : null };
  };
  try {
    // Only an admin may ask for both halves (a member gets 403), so both questions go out at
    // once rather than one after the other inside the session start's short budget.
    const [tasks, both, mine] = await Promise.all([
      getJson('/api/tasks?mine=true'),
      getJson('/api/bug-reports/notifications?role=both'),
      getJson('/api/bug-reports/notifications?role=reporter'),
    ]);
    const notif = both.status === 200 ? both : mine;
    if (tasks.status !== 200 || notif.status !== 200) return { host, status: 'error', items: [] };
    const items = [];
    for (const t of Array.isArray(tasks.data) ? tasks.data : []) {
      if (t?.id == null) continue;
      // A card the user opened but someone else took is waiting on them, not on the user.
      if (t.claimed_by && t.held_by_me !== true) continue;
      items.push({
        key: `ownmind:task#${t.id}`, kind: 'task', signal: '', paneOnly: true,
        title: String(t.title || ''), url: `${consoleUrl}/inbox/tasks`, ref: `task #${t.id}`,
        project: String(t.project || '').trim() || 'OwnMind', at: String(t.updated_at || t.created_at || ''),
      });
    }
    const unhandled = new Set();
    for (const b of Array.isArray(notif.data?.admin?.recent_unhandled) ? notif.data.admin.recent_unhandled : []) {
      if (b?.id == null) continue;
      unhandled.add(String(b.id));
      items.push({
        key: `ownmind:bug#${b.id}`, kind: 'bug', signal: '', paneOnly: true,
        title: String(b.title || ''), url: `${consoleUrl}/inbox/bugs`, ref: `bug #${b.id}`,
        project: OWNMIND_BUG_PROJECT, at: String(b.created_at || ''),
      });
    }
    const since = now.getTime() - RESOLVED_SHOWN_DAYS * 24 * 60 * 60 * 1000;
    for (const b of Array.isArray(notif.data?.reporter?.recent_resolved) ? notif.data.reporter.recent_resolved : []) {
      // A report reopened after it was resolved shows once, as waiting.
      if (b?.id == null || unhandled.has(String(b.id))) continue;
      const at = Date.parse(b.resolved_at || '');
      if (!Number.isFinite(at) || at < since) continue;
      items.push({
        key: `ownmind:bug#${b.id}`, kind: 'resolved', signal: '', paneOnly: true,
        title: String(b.title || ''), url: `${consoleUrl}/inbox/reports`, ref: `bug #${b.id}`,
        project: OWNMIND_BUG_PROJECT, at: String(b.resolved_at),
      });
    }
    return { host, status: 'ok', items };
  } catch {
    return { host, status: 'error', items: [] };
  }
}

// ---------------------------------------------------------------------------------------------
// What is new, and what the user sees

const idOf = (i) => `${i.key}:${i.kind}:${i.signal || ''}`;

/**
 * @param {object} state      previous state file contents ({} when none)
 * @param {Array}  results    collector answers: { host, status, items, commentMarks?, commentWho?, authoredMeta? }
 * @param {Date}   now
 * @returns {{ state, fresh, expired, firstToday }}
 */
export function decide(state, results, now) {
  const prev = state && typeof state === 'object' ? state : {};
  const day = localDateOnly(now);
  const firstToday = prev.day !== day;
  const shown = new Set(firstToday ? [] : (prev.shownToday || []));
  const hosts = { ...(prev.hosts || {}) };
  const baseline = { ...(prev.commentBaseline || {}) };
  const prevItems = Array.isArray(prev.items) ? prev.items : [];
  const expired = [];
  const current = [];
  // Items of a host that did not answer this time: kept for the pane, marked stale, never listed
  // as new — otherwise yesterday's list comes back every morning the host is unreachable.
  const carried = [];

  for (const r of results) {
    if (!r || !r.host) continue;
    if (r.status === 'ok') {
      hosts[r.host] = 'ok';
      for (const i of r.items || []) current.push({ ...i, host: r.host });
      for (const [k, mark] of Object.entries(r.commentMarks || {})) {
        const before = baseline[k];
        if (before !== undefined && mark && mark > before) {
          const meta = r.authoredMeta?.[k] || {};
          current.push({ key: k, kind: 'comment', signal: String(mark), title: meta.title || k, url: meta.url || '', ref: meta.ref || k, project: meta.project || '', at: String(mark), person: r.commentWho?.[k] || '', host: r.host });
        }
        baseline[k] = mark;
      }
      // A comment flagged earlier today stays in the pane for the rest of the day.
      if (!firstToday) {
        for (const p of prevItems) {
          if (p.host === r.host && p.kind === 'comment' && !current.some((c) => c.key === p.key && c.kind === 'comment')) current.push(p);
        }
      }
      continue;
    }
    if (r.status === 'refused' && (hosts[r.host] === 'ok' || hosts[r.host] === 'expired')) {
      hosts[r.host] = 'expired';
      expired.push(r.host);
    }
    // Not answered this time. Signed out or uninstalled: its items are gone. Otherwise the pane
    // keeps them, marked stale.
    if (r.status !== 'absent') {
      for (const p of prevItems) if (p.host === r.host) carried.push({ ...p, stale: true });
    }
  }

  // Pane-only items (OwnMind's own task cards and bug reports) are never listed as new.
  const fresh = current.filter((i) => !i.paneOnly && !shown.has(idOf(i)));
  for (const i of fresh) shown.add(idOf(i));

  return {
    firstToday,
    fresh,
    expired,
    state: {
      day,
      lastCheckAt: localIsoTimestamp(now),
      shownToday: [...shown],
      commentBaseline: baseline,
      hosts,
      items: [...current, ...carried],
    },
  };
}

function hostName(h) {
  try { return new URL(h.replace(/^gitlab:/, '')).host; } catch { return h; }
}

/** The user-facing text, or null when there is nothing to say. `t` is hooks/lib/i18n.js's t. */
export function render({ fresh, expired, firstToday }, t) {
  const lines = [];
  if (fresh.length) {
    lines.push(t(firstToday ? 'pendingItems.header.all' : 'pendingItems.header.new', { count: fresh.length }));
    // Someone waiting on the user comes first: a review request, then the user's own PR that
    // broke or got an answer, then the issues assigned to them.
    const order = { review: 0, failing: 1, comment: 2, assigned: 3 };
    const sorted = [...fresh].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
    for (const i of sorted.slice(0, MAX_LINES)) {
      lines.push(t('pendingItems.item', {
        label: t(`pendingItems.kind.${i.kind}`), title: i.title, ref: i.ref, url: i.url,
      }));
    }
    if (fresh.length > MAX_LINES) lines.push(t('pendingItems.more', { count: fresh.length - MAX_LINES }));
  }
  for (const h of expired) {
    lines.push(h === 'github'
      ? t('pendingItems.expired.github')
      : t('pendingItems.expired.gitlab', { host: hostName(h) }));
  }
  return lines.length ? lines.join('\n') : null;
}

export function isDue(state, now, minutes = RECHECK_MINUTES) {
  const last = Date.parse(state?.lastCheckAt || '');
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= minutes * 60 * 1000;
}

export function readState(statePath = defaultStatePath()) {
  try { return JSON.parse(fs.readFileSync(statePath, 'utf8')) || {}; } catch { return {}; }
}

function writeState(statePath, state) {
  const tmp = `${statePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, statePath);
  } catch {
    // The pane shows the previous list; the next check writes again.
    try { fs.unlinkSync(tmp); } catch { /* nothing was written */ }
  }
}

export function defaultCollectors({ hostsPath = defaultHostsPath(), timeoutMs = HOST_TIMEOUT_MS, credentials = readOwnMindCredentials } = {}) {
  const { apiUrl, apiKey } = credentials();
  return [
    { host: 'github', run: () => collectGithub({ timeoutMs }) },
    ...readGitHosts(hostsPath).map((host) => ({ host: `gitlab:${host.url}`, run: () => collectGitlab({ host, timeoutMs }) })),
    ...(apiUrl && apiKey ? [{ host: 'ownmind', run: () => collectOwnMind({ apiUrl, apiKey, timeoutMs }) }] : []),
  ];
}

function readOwnMindCredentials() {
  try { return readCredentials(); } catch { return { apiUrl: '', apiKey: '' }; }
}

/**
 * Every collector in parallel, under one shared deadline. A collector still running when the
 * deadline passes counts as an error for its host (its items stay in the pane, marked stale).
 * Collectors are either functions or { host, run }.
 */
export async function runCollectors(collectors, budgetMs = TOTAL_BUDGET_MS) {
  let timer;
  const deadline = new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); });
  try {
    return await Promise.all(collectors.map((c) => {
      const run = typeof c === 'function' ? c : c.run;
      const late = deadline.then(() => (typeof c === 'function' ? null : { host: c.host, status: 'error', items: [] }));
      return Promise.race([Promise.resolve().then(run).catch(() => null), late]);
    }));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run every collector in parallel, update the state file, and say what the user should see.
 * @returns {Promise<{ text: string|null, fresh: Array, expired: Array }>}
 */
export async function checkPendingItems({
  statePath = defaultStatePath(),
  collectors = defaultCollectors(),
  now = new Date(),
  t,
  budgetMs = TOTAL_BUDGET_MS,
} = {}) {
  if (process.env.OWNMIND_PENDING_ITEMS === 'off') return { text: null, fresh: [], expired: [] };
  try {
    const results = await runCollectors(collectors, budgetMs);
    const verdict = decide(readState(statePath), results.filter(Boolean), now);
    writeState(statePath, verdict.state);
    return { text: render(verdict, t), fresh: verdict.fresh, expired: verdict.expired };
  } catch {
    return { text: null, fresh: [], expired: [] };
  }
}

/** The per-prompt entry point: check only when the last check is an hour old. */
export async function recheckPendingItemsIfDue({ statePath = defaultStatePath(), now = new Date(), t, collectors } = {}) {
  if (process.env.OWNMIND_PENDING_ITEMS === 'off') return { text: null, fresh: [], expired: [] };
  if (!isDue(readState(statePath), now)) return { text: null, fresh: [], expired: [] };
  return checkPendingItems({ statePath, now, t, ...(collectors && { collectors }) });
}

/** The model-facing note that rides along with the user-facing text. English by policy. */
export function contextNote(text) {
  if (!text) return '';
  return [
    '[OwnMind] The user was just shown these items waiting on them on GitHub / GitLab:',
    text,
    'You do not need to repeat the list. If the user asks to handle one, open its link.',
  ].join('\n');
}
