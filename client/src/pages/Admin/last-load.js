// What the team page's "最近一次載入記憶" cell shows for one member.
//
// The admin wants to know, from his desk, whether a colleague's OwnMind is really loading
// memories on their computer. The answer is one of three lights (the console has no others)
// or, for someone who has not installed yet, plain muted text with no light:
//
//   green   this member's computer has loaded memories (and no install error came after)
//   yellow  installed, but no load yet — opening a new conversation turns it green
//   red     the install reported an error, and nothing has loaded since
//   none    no install and no load yet, or the account is deactivated
//
// The Chinese wording behind these keys (team.col.last_load, team.load.* in zh.json) was shown
// to the product owner as a mockup and is pending his final approval; en/ja are pinned in the
// override files.
//
// Pure function: the page passes the row and `now`; times are shown in the viewer's local
// time. Texts are returned as i18n keys plus params so the page can translate them.

function parse(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

const pad2 = (n) => String(n).padStart(2, '0');
const hhmm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * @param {object} row  A /api/admin/users row (last_memory_load_at, last_machine,
 *                      first_install_at, last_install_error_at, deactivated_at).
 * @param {Date} now
 * @returns {{
 *   light: 'green'|'yellow'|'red'|'none',
 *   labelKey: string|null, labelParams: object|null,
 *   detail: ({text: string}|{key: string, params: object}|null),
 *   tipKey: string|null, pill: boolean, deactivated: boolean,
 * }}
 */
export function lastLoadState(row, now = new Date()) {
  const base = { labelKey: null, labelParams: null, detail: null, tipKey: null, pill: false, deactivated: false };
  if (row.deactivated_at) return { ...base, light: 'none', deactivated: true };

  const load = parse(row.last_memory_load_at);
  const error = parse(row.last_install_error_at);
  const installed = parse(row.first_install_at);
  const machine = row.last_machine || null;

  // An error counts only while nothing has loaded since: a member who loaded memories after
  // a failed install is working, so the older error must not turn the light red.
  if (error && (!load || error.getTime() > load.getTime())) {
    return {
      ...base, light: 'red', pill: true, tipKey: 'team.load.tip.red',
      labelKey: 'team.load.error',
      detail: { key: 'team.load.error_detail', params: { time: `${md(error)} ${hhmm(error)}` } },
    };
  }

  if (load) {
    const days = Math.round((startOfDay(now) - startOfDay(load)) / 86_400_000);
    let labelKey = 'team.load.dated';
    let labelParams = { date: md(load), time: hhmm(load) };
    if (days <= 0) { labelKey = 'team.load.today'; labelParams = { time: hhmm(load) }; }
    else if (days === 1) { labelKey = 'team.load.yesterday'; labelParams = { time: hhmm(load) }; }
    return {
      ...base, light: 'green', tipKey: 'team.load.tip.green', labelKey, labelParams,
      detail: machine ? { text: machine } : null,
    };
  }

  if (installed) {
    const date = md(installed);
    return {
      ...base, light: 'yellow', pill: true, tipKey: 'team.load.tip.yellow',
      labelKey: 'team.load.never',
      detail: machine
        ? { key: 'team.load.never_detail', params: { machine, date } }
        : { key: 'team.load.never_detail_nomachine', params: { date } },
    };
  }

  return { ...base, light: 'none', labelKey: 'team.load.not_installed' };
}
