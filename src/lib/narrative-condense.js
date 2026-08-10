/**
 * Shrink the narrative payload until the upstream will accept it.
 *
 * Measured on production 2026-08-10 against the LLM switch, one request every 20 seconds
 * so rate limiting could not be mistaken for a size limit: a body of 39,600 bytes goes
 * through, 41,025 comes back 413 Payload Too Large, and every provider behind the switch
 * refuses the same. The ceiling is 40 KiB.
 *
 * The three ranges the page offers measured 32,372 / 47,893 / 52,842 bytes, so the report
 * worked for 7 days and answered 502 for 14 and 30 — on every call, not intermittently.
 *
 * What this does NOT do is cut the payload down to a fixed size and hope. It shrinks in
 * ordered steps, measuring after each one and stopping the moment it fits, because the
 * cheapest step that works is the one that loses the least. A 7-day report is inside the
 * budget and comes back untouched.
 *
 * The order is by information density, not by size:
 *   1. Long friction notes are truncated. They are prose, and the first sentences carry
 *      the point; the tail is usually the same incident restated.
 *   2. Compliance rows with nothing to report are dropped, with a count left behind. A
 *      rule everybody followed is the least interesting row in the file.
 *   3. The version list is collapsed to one row per machine, keeping the OLDEST version
 *      seen on it. That section is read to find who is behind; keeping the newest would
 *      hide precisely that.
 *
 * Whatever it did is written into `_condensed` so the model is reading a summary knowingly
 * rather than a full record it will then describe as complete.
 */

/**
 * Measured: 39,600 bytes goes through, 41,025 comes back 413. The ceiling is 40 KiB.
 *
 * 38,000 leaves roughly 3 KB of margin, which is the room the system prompt has to grow
 * without this silently starting to cut data. It is deliberately NOT tighter: the 7-day
 * report measures 32,372 bytes, and a budget under that would condense the one range that
 * has always worked — buying nothing and quietly making today's report coarser.
 */
export const REQUEST_BUDGET_BYTES = 38_000;

/** Progressively harder caps on a single friction note, in characters. */
const FRICTION_CAPS = [600, 400, 250, 150, 80];

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

  // Deep-copied once: the caller's object is also what the cache key was computed from.
  let work = structuredClone(sections);
  const notes = [];

  for (const cap of FRICTION_CAPS) {
    const trimmed = truncateFriction(work.project_friction_raw, cap);
    if (trimmed.changed) {
      work = { ...work, project_friction_raw: trimmed.rows };
      setNote(notes, 'friction', `逐筆摩擦紀錄每則截到 ${cap} 字以內（共 ${trimmed.rows.length} 則，未刪除任何一則）`);
      if (measure(work) <= budgetBytes) return finish(work, notes, true);
    }

    // Only reached once the friction notes are as short as this cap allows.
    if (cap === FRICTION_CAPS[0]) {
      const c = dropCleanCompliance(work.compliance);
      if (c.dropped > 0) {
        work = { ...work, compliance: c.rows };
        notes.push(`compliance 只保留有違反或跳過的 ${c.rows.length} 條，另外 ${c.dropped} 條全部遵從的沒有列出`);
        if (measure(work) <= budgetBytes) return finish(work, notes, true);
      }
      const v = collapseVersions(work.versions);
      if (v.dropped > 0) {
        work = { ...work, versions: v.rows };
        notes.push(`版本清單每台機器收成一列（原 ${v.rows.length + v.dropped} 列），版本取該台最舊的那個`);
        if (measure(work) <= budgetBytes) return finish(work, notes, true);
      }
    }
  }

  // Last resort. The three steps above are aimed at the sections that were actually large
  // on production, and they are enough for today's data by a wide margin. But every list
  // here grows with the team, and a section nobody anticipated getting big would otherwise
  // sail past all of them, come back over budget, and be sent anyway — which is the 502
  // this exists to stop. So: trim whatever the largest list currently is, one bite at a
  // time, and say how many rows were left out. Predictable degradation beats an error.
  work = trimLargestLists(work, budgetBytes, measure, notes);

  return finish(work, notes, measure(work) <= budgetBytes);
}

function trimLargestLists(work, budgetBytes, measure, notes) {
  const dropped = new Map();
  // Bounded so a payload that cannot shrink (a single enormous row) ends the loop rather
  // than spinning: each pass removes at least one row from the biggest list, or stops.
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
    dropped.set(biggest, (dropped.get(biggest) ?? 0) + (work[biggest].length - keep));
    work = { ...work, [biggest]: work[biggest].slice(0, keep) };
  }
  for (const [k, n] of dropped) {
    notes.push(`${k} 太大，只保留前 ${work[k].length} 列，另外 ${n} 列沒有列出`);
  }
  return work;
}

function finish(work, notes, fits) {
  if (!fits) notes.push('已用盡所有精簡手段，內容仍然偏大');
  return { sections: { ...work, _condensed: notes }, notes, fits };
}

/** Replace a note in `notes` that starts with the same tag, so a harder cap supersedes. */
function setNote(notes, tag, text) {
  const at = notes.findIndex((n) => n.startsWith('逐筆摩擦紀錄'));
  if (at >= 0) notes[at] = text;
  else notes.push(text);
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

function dropCleanCompliance(rows) {
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
    if (!prev || isOlder(r?.version, prev.version)) {
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

/** Compare dotted versions numerically; anything unparseable sorts as older. */
function isOlder(a, b) {
  const parts = (v) => String(v ?? '').split('.').map((n) => Number.parseInt(n, 10));
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const xi = Number.isFinite(x[i]) ? x[i] : -1;
    const yi = Number.isFinite(y[i]) ? y[i] : -1;
    if (xi !== yi) return xi < yi;
  }
  return false;
}
