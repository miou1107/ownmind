/**
 * Shrink the narrative payload so the upstream is more likely to accept it.
 *
 * **Corrected 2026-08-11.** This file used to state that the gateway has a hard 40 KiB
 * ceiling, measured by bisection on 2026-08-10. That reading was wrong, and the way it was
 * wrong is worth keeping: the probe bodies were built by repeating one short phrase, which
 * costs far fewer tokens per byte than a real report, so the boundary that bisection found
 * was not a boundary in bytes at all.
 *
 * What was measured the next day, against the same gateway:
 *
 *   - a 40,214-byte probe body went through
 *   - the route's real 35,301-byte 14-day body was refused four times in one ten-minute
 *     window, then accepted on three sequential and three concurrent replays afterwards
 *   - the endpoint itself then answered 200 five times in a row
 *
 * So the gateway refuses on capacity at that moment, not on size, and a larger payload is
 * simply likelier to exceed whatever budget is left. The 7-day report (31,929 bytes) kept
 * working throughout for that reason and no other.
 *
 * Condensing therefore buys better odds, not a guarantee. The guarantee, as far as there is
 * one, is the retry in `callLLMSwitch` — a gateway that is busy now is usually not busy
 * three seconds later.
 *
 * This does not cut the payload to a fixed size and hope. It shrinks in ordered steps,
 * measuring after each one and stopping the moment it fits, because the cheapest step that
 * works is the one that loses the least. A 7-day report is inside the budget and comes back
 * untouched.
 *
 * The order is by information density, not by size:
 *   1. Long friction notes are truncated. They are prose, and the first sentences carry the
 *      point; the tail is usually the same incident restated.
 *   2. Compliance rows with nothing to report are dropped, with a count left behind. A rule
 *      nobody broke is the least interesting row in the file.
 *   3. The version list is collapsed to one row per machine, keeping the OLDEST version seen
 *      on it. That section is read to find who is behind; keeping the newest would hide
 *      precisely that.
 *   4. Last resort: trim whatever the largest list currently is. This covers a section
 *      nobody anticipated growing — without it such a section sails past every targeted
 *      step, comes back over budget, and is posted anyway, which is the 502 this removes.
 *
 * Two things are structural rather than remembered:
 *
 * - **The notes are derived from the before/after state, never accumulated.** An earlier
 *   version pushed a note per step, and a note from step 1 ("no entry was deleted") could
 *   still be sitting there after step 4 had deleted entries. Describing the final state
 *   makes that contradiction unrepresentable.
 * - **The size that is checked includes the notes.** They travel with the payload, so a
 *   measurement taken before they are attached is a measurement of something nobody posts.
 */

/**
 * Not a ceiling — there is no fixed one (see the correction above). This is the size past
 * which a payload is worth shrinking, and it is a trade rather than a limit: a smaller body
 * is refused less often, and a body that has been cut says less.
 *
 * Deliberately NOT tighter: the 7-day report measures 31,929 bytes and has never been
 * refused, so a budget under that would condense the one range that works, making today's
 * report coarser in exchange for nothing.
 *
 * Deliberately NOT looser: 14 and 30 days arrive at roughly 48,000 and 53,000 bytes, and
 * both were refused during a busy window while the 7-day body went through.
 */
export const REQUEST_BUDGET_BYTES = 38_000;

/** Progressively harder caps on a single friction note, in characters. */
const FRICTION_CAPS = [600, 400, 250, 150, 80];

/**
 * Lists whose order is time, oldest first. Trimming these from the front would drop the
 * most recent days, which is the end a reader cares about.
 */
const TIME_ORDERED = new Set(['daily', 'hourly', 'weekday']);

/** Section names as they read to someone who does not work on this code. */
const SECTION_NAMES = {
  project_friction_raw: '逐筆踩坑紀錄',
  compliance: '規則遵守紀錄',
  versions: '版本清單',
  project_ranking: '專案排名',
  ranking: '成員排名',
  daily: '每日活動',
  hourly: '時段分布',
  weekday: '星期分布',
  event_types: '事件類型',
};
const nameOf = (k) => SECTION_NAMES[k] ?? k;

const sizeOf = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');

/**
 * @param {Object} sections - the mechanical report, as collectSections produces it
 * @param {Object} [opts]
 * @param {number} [opts.budgetBytes]
 * @param {(sections: Object) => number} [opts.measure] - defaults to the serialized size;
 *   the route passes one that measures the whole request body, so the number this decides
 *   against is the number the upstream will see
 * @returns {{ sections: Object, notes: string[], fits: boolean }}
 */
export function condenseSections(sections, opts = {}) {
  const budgetBytes = opts.budgetBytes ?? REQUEST_BUDGET_BYTES;
  const measure = opts.measure ?? sizeOf;

  if (!sections || typeof sections !== 'object') return { sections, notes: [], fits: true };
  if (measure(sections) <= budgetBytes) return { sections, notes: [], fits: true };

  const original = sections;
  // Deep-copied once: the caller's object is also what the response is shaped from.
  let work = structuredClone(sections);

  /** The object that would actually be posted, notes included. */
  const withNotes = (w) => ({ ...w, _condensed: describe(original, w) });
  const fitsNow = (w) => measure(withNotes(w)) <= budgetBytes;

  for (const cap of FRICTION_CAPS) {
    const trimmed = truncateFriction(work.project_friction_raw, cap);
    if (trimmed.changed) {
      work = { ...work, project_friction_raw: trimmed.rows };
      if (fitsNow(work)) return done(original, work, true);
    }

    // Run once, after the gentlest friction cap: these two are lossier per byte saved.
    if (cap === FRICTION_CAPS[0]) {
      const c = dropQuietCompliance(work.compliance);
      if (c.dropped > 0) {
        work = { ...work, compliance: c.rows };
        if (fitsNow(work)) return done(original, work, true);
      }
      const v = collapseVersions(work.versions);
      if (v.dropped > 0) {
        work = { ...work, versions: v.rows };
        if (fitsNow(work)) return done(original, work, true);
      }
    }
  }

  work = trimLargestLists(work, budgetBytes, (w) => measure(withNotes(w)));
  return done(original, work, fitsNow(work));
}

function done(original, work, fits) {
  const notes = describe(original, work, fits);
  return { sections: { ...work, _condensed: notes }, notes, fits };
}

/**
 * State the difference between what was collected and what is being sent.
 *
 * Derived, not accumulated: every sentence here is read off the final payload, so it cannot
 * describe a step that a later step undid.
 */
function describe(original, work, fits = true) {
  const notes = [];

  const of = original.project_friction_raw;
  const wf = work.project_friction_raw;
  if (Array.isArray(of) && Array.isArray(wf)) {
    const shortened = wf.filter((r, i) => (r?.friction?.length ?? 0) < (of[i]?.friction?.length ?? 0)).length;
    const missing = of.length - wf.length;
    if (missing > 0) {
      notes.push(`${nameOf('project_friction_raw')}只列出 ${wf.length} 則，另外 ${missing} 則沒有列出`
        + (shortened > 0 ? '，列出的內容也有截短' : ''));
    } else if (shortened > 0) {
      const cap = Math.max(...wf.map((r) => r?.friction?.length ?? 0));
      notes.push(`${nameOf('project_friction_raw')}共 ${of.length} 則全部保留，較長的截到約 ${cap} 字`);
    }
  }

  const oc = original.compliance;
  const wc = work.compliance;
  if (Array.isArray(oc) && Array.isArray(wc) && wc.length < oc.length) {
    notes.push(`${nameOf('compliance')}只列出有違反或跳過的 ${wc.length} 條，另外 ${oc.length - wc.length} 條沒有列出`);
  }

  const ov = original.versions;
  const wv = work.versions;
  if (Array.isArray(ov) && Array.isArray(wv) && wv.length < ov.length) {
    notes.push(`${nameOf('versions')}每台機器收成一列（原 ${ov.length} 列），版本取該台最舊的那個，看不出是哪個工具落後`);
  }

  for (const [k, v] of Object.entries(work)) {
    if (k === 'project_friction_raw' || k === 'compliance' || k === 'versions') continue;
    const o = original[k];
    if (Array.isArray(o) && Array.isArray(v) && v.length < o.length) {
      notes.push(`${nameOf(k)}只列出 ${v.length} 列，另外 ${o.length - v.length} 列沒有列出`);
    }
  }

  if (!fits) notes.push('已用盡所有精簡手段，內容仍然偏大');
  return notes;
}

function truncateFriction(rows, cap) {
  if (!Array.isArray(rows)) return { rows, changed: false };
  let changed = false;
  const out = rows.map((r) => {
    const text = typeof r?.friction === 'string' ? r.friction : '';
    if (text.length <= cap) return r;
    changed = true;
    return { ...r, friction: text.slice(0, cap) + '…' };
  });
  return { rows: out, changed };
}

/**
 * Drop the compliance rows with nothing to report.
 *
 * "Nothing to report" is no violation and no skip. It is not the same as "fully compliant":
 * a row can be observed-only, with every counter at zero. The note says "no violation or
 * skip" rather than "fully compliant" for that reason.
 */
function dropQuietCompliance(rows) {
  if (!Array.isArray(rows)) return { rows, dropped: 0 };
  const keep = rows.filter((c) => Number(c?.violate ?? 0) > 0 || Number(c?.skip ?? 0) > 0);
  return { rows: keep, dropped: rows.length - keep.length };
}

function collapseVersions(rows) {
  if (!Array.isArray(rows)) return { rows, dropped: 0 };
  const byMachine = new Map();
  for (const r of rows) {
    const key = `${r?.user_id}::${r?.machine}`;
    const prev = byMachine.get(key);
    if (!prev || prefer(r?.version, prev.version)) {
      byMachine.set(key, {
        user_id: r?.user_id,
        machine: r?.machine,
        version: r?.version,
        last_reported_at: r?.last_reported_at,
      });
    }
  }
  const out = [...byMachine.values()];
  return { rows: out, dropped: rows.length - out.length };
}

/**
 * Should `candidate` replace `current` as the machine's reported version?
 *
 * Oldest wins, because the section is read to find who is behind. But an unreadable value
 * never wins over a readable one: `scanner_version` is nullable and does turn up as null or
 * "unknown" in production, and sorting those as oldest would replace a real "1.26.27" with
 * a blank — erasing exactly the answer the section exists to give.
 */
function prefer(candidate, current) {
  const cOk = parsable(candidate);
  const curOk = parsable(current);
  if (cOk !== curOk) return cOk;
  if (!cOk) return false;
  return isOlder(candidate, current);
}

function parsable(v) {
  return /^\d+(\.\d+)*$/.test(String(v ?? '').trim());
}

/** Compare dotted versions numerically. Both sides are known parsable. */
function isOlder(a, b) {
  const parts = (v) => String(v).trim().split('.').map((n) => Number.parseInt(n, 10));
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const xi = Number.isFinite(x[i]) ? x[i] : 0;
    const yi = Number.isFinite(y[i]) ? y[i] : 0;
    if (xi !== yi) return xi < yi;
  }
  return false;
}

function trimLargestLists(work, budgetBytes, measure) {
  // Bounded so a payload that cannot shrink (one enormous row) ends the loop rather than
  // spinning: each pass removes at least one row from the biggest list, or stops.
  for (let pass = 0; pass < 500 && measure(work) > budgetBytes; pass += 1) {
    let biggest = null;
    let biggestSize = 0;
    for (const [k, v] of Object.entries(work)) {
      if (!Array.isArray(v) || v.length <= 1) continue;
      const size = sizeOf(v);
      if (size > biggestSize) { biggest = k; biggestSize = size; }
    }
    if (!biggest) break;
    const keep = Math.max(1, Math.floor(work[biggest].length * 0.8));
    // Time-ordered lists run oldest first, so keep the end.
    work = {
      ...work,
      [biggest]: TIME_ORDERED.has(biggest)
        ? work[biggest].slice(-keep)
        : work[biggest].slice(0, keep),
    };
  }
  return work;
}
