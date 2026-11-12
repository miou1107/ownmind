import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Item, View } from '../types'

// The issues, PRs and MRs waiting on the user (issue #203), as a board: one group per project,
// a card per item. The session-start and prompt hooks do the checking and keep the full list in
// ~/.ownmind/state/pending-items.json; this pane reads that file, and its refresh button runs
// the same check once more through hooks/pending-items-check.js. A card's hide button drops the
// item for good: its key goes into pending-items-hidden.json, which the check reads as well.
const PANE = 'pending-items'
const TITLE = '待處理單據'
const STALE_DAYS = 14

const EMPTY: View = { items: [], checkedAt: '', isLoaded: false }
// v1.33.5: items gained project, source and at. The new tag drops what v1.33.4 stored.
const view = atom({ plugin: 'pending-items', key: 'view' } as const, EMPTY, { shape: 'view-2' })
const filter = atom({ plugin: 'pending-items', key: 'filter' } as const, '', { shape: 'filter-1' })
const collapsed = atom({ plugin: 'pending-items', key: 'collapsed' } as const, [] as string[], { shape: 'collapsed-1' })
const busy = atom({ plugin: 'pending-items', key: 'busy' } as const, false, { shape: 'busy-1' })

// Waiting first, then the newest change.
const ORDER: Record<Item['kind'], number> = { review: 0, failing: 1, comment: 2, bug: 3, assigned: 4, task: 5, resolved: 6 }

// A dot per project, picked from the name so a project keeps its colour between sessions.
// Theme colours: the desktop draws a Text's colour from the theme, not from a hex value.
const DOTS = ['suggestion', 'success', 'merged', 'warning', 'claude', 'ide', 'permission', 'planMode', 'autoAccept', 'remember']
const hashOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
const dotOf = (name: string) => DOTS[hashOf(name) % DOTS.length]

// Simple Icons' marks (CC0). GitHub's in a grey that reads on light and dark panes alike.
const GITHUB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#8b949e" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
// OwnMind's own mark, as on its website: task cards and bug reports live in OwnMind.
const OWNMIND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="28" fill="#4a8a62"/><path d="M64 24c-19 0-34 14-34 32 0 9 4 17 10 23v15h30v-8h8c4 0 8-4 8-8V66l8-2-8-14c-2-15-10-26-22-26z" fill="none" stroke="#fff" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"/><path d="M50 58l9 9 18-18" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
const GITLAB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#FC6D26" d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"/></svg>'
const LOGO: Record<Item['source'], { svg: string; name: string }> = {
  github: { svg: GITHUB_SVG, name: 'GitHub' },
  gitlab: { svg: GITLAB_SVG, name: 'GitLab' },
  ownmind: { svg: OWNMIND_SVG, name: 'OwnMind' },
}

// The pane cannot tell a light app from a dark one, so the fills are a translucent grey that
// reads on both: a faint one for the project group, a firmer one for each card on top of it.
// The terminal draws a card as a rounded border instead.
const LANE_BG = 'rgba(127,127,127,0.10)'
// The theme's inverse-text colour is the app's own page colour: white cards in a light app,
// dark cards in a dark one, each standing out from the grey group behind it.
const CARD_BG = 'inverseText'
const CARD_HOVER = 'rgba(127,127,127,0.08)'
const COUNT_BG = 'rgba(99,102,241,0.14)'

/** "Jane Doe" -> "JD", "member4" -> "M", a CJK name -> its first character; '' for nobody. */
export const initials = (name: string) => {
  // The first letter or digit of each word; punctuation and emoji are skipped.
  const words = name.split(/[\s._-]+/).map(w => /[\p{L}\p{N}]/u.exec(w)?.[0] ?? '').filter(Boolean)
  if (words.length === 0) return ''
  // One character each, even where upper case is longer (ß -> SS).
  const one = (c: string) => [...c.toUpperCase()][0]!
  if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(words[0]!)) return words[0]!
  return words.length > 1 ? one(words[0]!) + one(words[words.length - 1]!) : one(words[0]!)
}

// A filled circle with the initials, in a colour picked from the name so a person keeps it.
// Hex is fine inside the Svg's own source; only Text colours have to come from the theme.
const AVATAR_FILLS = ['#6366f1', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6']
const escapeXml = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
// The <title> is the tooltip: the full name, shown while the pointer rests on the circle.
// The circle stops half a unit short of the image's edge, so its rim is never cut where the
// surface rounds the image's size.
const avatarSvg = (text: string, name: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><title>${escapeXml(name)}</title><circle cx="10" cy="10" r="9.5" fill="${AVATAR_FILLS[hashOf(name) % AVATAR_FILLS.length]}"/>` +
  `<text x="10" y="10" dy="0.35em" text-anchor="middle" font-family="-apple-system,'Segoe UI',sans-serif" font-size="${[...text].length > 1 ? 8.5 : 10}" font-weight="600" fill="#fff">${escapeXml(text)}</text></svg>`

const pad = (n: number) => String(n).padStart(2, '0')
const clockTime = (iso: string) => {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Whole calendar days between the item's last change and today, in local time; null if unknown. */
export const daysAgo = (iso: string, now = new Date()) => {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  return Math.max(0, Math.round((day(now) - day(new Date(ms))) / 86400000))
}
export const ageText = (d: number) => (d === 0 ? '今天' : d === 1 ? '昨天' : `${d} 天前`)

/** `owner/repo issue #68` -> `#68`, `owner/repo PR #7` -> `!7` (as GitLab writes a merge request), `g/p#112` -> `#112`, `g/p!4` -> `!4`. */
export const shortRef = (ref: string) => {
  const gh = /\s(issue|PR)\s#(\d+)$/.exec(ref)
  if (gh) return gh[1] === 'PR' ? `!${gh[2]}` : `#${gh[2]}`
  const gl = /([#!]\d+)$/.exec(ref)
  return gl ? gl[1] : ref
}

/** The repository's name from a ref, for state files written before items carried a project. */
const projectFromRef = (ref: string) => ref.replace(/\s.*$/, '').replace(/[#!]\d+$/, '').split('/').pop() || ref

// Windows may have no HOME, or a Git Bash form (/c/Users/x) that native file APIs cannot
// open; USERPROFILE is the real one there. Same rule as the monitor mod.
const homeDir = async ($: any) => {
  const home = (await $.env.get('HOME')) ?? ''
  const profile = (await $.env.get('USERPROFILE')) ?? ''
  return profile && (!home || /^\/[a-zA-Z]\//.test(home)) ? profile : home
}

const joinPath = (base: string, ...parts: string[]) => {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

const KINDS = new Set(['assigned', 'review', 'failing', 'comment', 'task', 'bug', 'resolved'])

const sourceOf = (host: string): Item['source'] =>
  host.startsWith('github') ? 'github' : host.startsWith('ownmind') ? 'ownmind' : 'gitlab'

// OwnMind's bug reports arrive under one fixed project key; the pane names the group.
const BUG_PROJECT = '#reports'
/** The name drawn for a group. */
export const groupName = (g: { source: Item['source']; project: string }) =>
  g.source === 'ownmind' && g.project === BUG_PROJECT ? '問題回報' : g.project

export const parseState = (text: string): View => {
  try {
    const s = JSON.parse(text)
    const items: Item[] = (Array.isArray(s?.items) ? s.items : [])
      .filter((i: any) => i && typeof i.key === 'string' && KINDS.has(i.kind))
      .map((i: any) => {
        const ref = String(i.ref ?? '')
        return {
          key: i.key,
          kind: i.kind,
          title: String(i.title ?? ''),
          url: String(i.url ?? ''),
          ref,
          project: String(i.project || '') || projectFromRef(ref),
          source: sourceOf(String(i.host || i.key)),
          at: String(i.at ?? ''),
          person: String(i.person ?? ''),
        }
      })
    return { items, checkedAt: String(s?.lastCheckAt ?? ''), isLoaded: true }
  } catch {
    return EMPTY
  }
}

export type Group = { key: string; project: string; source: Item['source']; items: Item[] }

/** One group per project and place, the biggest first; inside, waiting first, then newest. */
export const groupItems = (items: Item[]): Group[] => {
  const map = new Map<string, Group>()
  for (const i of items) {
    const key = `${i.source}:${i.project}`
    if (!map.has(key)) map.set(key, { key, project: i.project, source: i.source, items: [] })
    map.get(key)!.items.push(i)
  }
  const groups = [...map.values()]
  for (const g of groups) g.items.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || b.at.localeCompare(a.at))
  return groups.sort((a, b) => b.items.length - a.items.length || a.project.localeCompare(b.project))
}

const statePath = async ($: any) => joinPath(await homeDir($), '.ownmind', 'state', 'pending-items.json')
// The items the person hid from their cards. The pane writes this file; the check reads it too,
// so a hidden item is not listed when a conversation starts either.
const hiddenPath = async ($: any) => joinPath(await homeDir($), '.ownmind', 'state', 'pending-items-hidden.json')

export type Hidden = { key: string; title: string; at: string }

/** The hidden list in a file's text; null when the text is not such a file (half written, damaged). */
export const parseHidden = (text: string): Hidden[] | null => {
  try {
    const list = JSON.parse(text)?.hidden
    if (!Array.isArray(list)) return null
    return list
      .map((h: any) => (typeof h === 'string' ? { key: h } : h))
      .filter((h: any) => h && typeof h.key === 'string' && h.key)
      .map((h: any) => ({ key: h.key, title: String(h.title ?? ''), at: String(h.at ?? '') }))
  } catch {
    return null
  }
}

// For drawing: whatever cannot be read hides nothing.
const readHidden = async ($: any): Promise<Hidden[]> => {
  try { return parseHidden(await $.fs.read(await hiddenPath($))) ?? [] } catch { return [] /* nothing hidden yet */ }
}

/**
 * For writing: the list as it stands, or null when a file is there but cannot be read as one.
 * Writing over such a file would bring every item hidden earlier back, so the caller must stop.
 */
const loadHidden = async ($: any, path: string): Promise<Hidden[] | null> => {
  let text: string
  try {
    text = await $.fs.read(path)
  } catch {
    let isThere = false
    try { isThere = await $.fs.exists(path) } catch { /* cannot tell: treated as not there */ }
    return isThere ? null : []
  }
  return parseHidden(text)
}

const refresh = async ($: any) => {
  let next = EMPTY
  try {
    next = parseState(await $.fs.read(await statePath($)))
  } catch { /* no file yet: nothing has been checked on this machine */ }
  // The state file still lists a hidden item until the next check rewrites it.
  const hidden = new Set((await readHidden($)).map(h => h.key))
  if (hidden.size > 0) next = { ...next, items: next.items.filter(i => !hidden.has(i.key)) }
  await update($, view, () => next)
  return next
}

// A long title is cut in the question; the card it came from is still on screen behind it.
const ASK_TITLE_MAX = 30
const HIDE = '隱藏'
const HIDE_FAILED = 'OwnMind 沒有存下這次隱藏，請再按一次「隱藏」'
// A bell with a slash, the emoji the product owner picked: hiding a card means never being
// reminded of the item again. The pane's elements have no icon a Button may hold.
export const HIDE_GLYPH = '\u{1F515}'
// The width kept for the hide control at the end of a card's last row, in character cells:
// room for one emoji.
const HIDE_SLOT = 3

/** Hides one item for good, after the person confirms: its card goes and it is never listed again. */
const hideItem = async ($: any, i: Item) => {
  const chars = [...i.title]
  const title = chars.length > ASK_TITLE_MAX ? `${chars.slice(0, ASK_TITLE_MAX).join('')}…` : i.title
  let answer = ''
  try {
    answer = await $.ui.ask(`注意！隱藏後不會再提醒。確定隱藏「${title}」？`, { options: [HIDE, '取消'], header: '隱藏單據' })
  } catch { return /* dismissed: nothing is hidden */ }
  if (answer !== HIDE) return
  // Read again at the last moment: another window may have hidden something since this one drew.
  const path = await hiddenPath($)
  const list = await loadHidden($, path)
  if (!list) { $.ui.toast(HIDE_FAILED); return }
  if (!list.some(h => h.key === i.key)) list.push({ key: i.key, title: i.title, at: new Date().toISOString() })
  try {
    await $.fs.write(path, JSON.stringify({ hidden: list }, null, 2))
  } catch {
    $.ui.toast(HIDE_FAILED)
    return
  }
  await refresh($)
}

// The refresh button: ask GitHub and GitLab again, then reread the file. Node may not be on
// the desktop app's PATH, so the usual install places are tried after it, Windows' included.
const NODES = ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', 'C:\\Program Files\\nodejs\\node.exe']
// $.process.run rejects both when the program cannot start and when it outlives its timeout.
// Only the first means "try the next place"; a check that ran out of time is not retried.
const isTimeout = (err: unknown) => /time(d)?\s*out|timeout/i.test(String((err as any)?.message ?? err))
// Where OwnMind's own scripts are installed.
const hooksDir = async ($: any) => joinPath(await homeDir($), '.ownmind', 'hooks')
/** Runs one of OwnMind's scripts with node and resolves to what it printed; null when it could not run. */
const runScript = async ($: any, name: string, args: string[], timeoutMs: number): Promise<string | null> => {
  const script = joinPath(await hooksDir($), name)
  for (const node of NODES) {
    try {
      const r = await $.process.run([node, script, ...args], { timeoutMs })
      return String(r?.stdout ?? '')
    } catch (err) {
      if (isTimeout(err)) return null
    }
  }
  return null
}

let running = false
const checkNow = async ($: any) => {
  // A plain flag, set before any await, so two quick presses start one check.
  if (running) return
  running = true
  await update($, busy, () => true)
  try {
    await runScript($, 'pending-items-check.js', [], 30000)
    await refresh($)
  } finally {
    running = false
    await update($, busy, () => false)
  }
}

// OwnMind's own items are handled in the conversation, not on a web page: pressing the title of a
// task card or a bug report puts a one-line request in the prompt box for the person to send, and
// when they send it the prompt hook below hands the model the item in full.
const TASK_WORD = '任務卡'
const BUG_WORD = '問題回報'
const OWN_KEY = /^ownmind:(task|bug)#(\d+)$/
/** The request for an OwnMind item, e.g. "查看 OwnMind 任務卡 #3"; '' for any other item. */
export const requestFor = (key: string) => {
  const m = OWN_KEY.exec(key)
  return m ? `查看 OwnMind ${m[1] === 'task' ? TASK_WORD : BUG_WORD} #${m[2]}` : ''
}
/**
 * Which OwnMind item a prompt asks to see, or null. Only a line that is exactly the request the
 * pane writes counts: a mention of an item's number in the middle of other text does not.
 */
export const requestedIn = (text: string) => {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const id = /#(\d{1,9})$/.exec(line)?.[1]
    if (!id) continue
    if (line === requestFor(`ownmind:task#${id}`)) return { kind: 'task', id }
    if (line === requestFor(`ownmind:bug#${id}`)) return { kind: 'bug', id }
  }
  return null
}

// Into the prompt box, after whatever the person has already typed there.
const toPromptBox = async ($: any, text: string) => {
  let draft = ''
  try { draft = String((await $.prompt.read())?.text ?? '') } catch { /* no box to read: fill says so below */ }
  let filled = false
  try {
    const r = await $.prompt.fill(draft.trim() ? { text: `\n${text}`, mode: 'append' } : { text })
    filled = r?.isFilled !== false
  } catch { /* refused: say so */ }
  if (!filled) $.ui.toast('OwnMind 沒有把這句話放進輸入框，請再點一次標題')
}

// A pane cannot navigate, so a card's title opens the item in the person's default browser.
// URLs come from GitHub and GitLab; only http(s) is passed on, as one argument, never through a shell string.
const openUrl = async ($: any, url: string) => {
  if (!/^https?:\/\//.test(url)) return
  const windows = /\\/.test(await homeDir($))
  const tries = windows ? [['rundll32', 'url.dll,FileProtocolHandler', url]] : [['open', url], ['/usr/bin/open', url], ['xdg-open', url]]
  for (const argv of tries) {
    try { await $.process.run(argv, { timeoutMs: 10000 }); return } catch { /* try the next opener */ }
  }
}

const saveFolds = async ($: any, keys: string[]) => {
  try { await $.store.set('collapsed', keys) } catch { /* the fold is a convenience; losing it is fine */ }
}

const openPane = ($: any) => $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pending-items', description: '打開待處理單據面板' })
    try {
      const saved = await $.store.get('collapsed')
      if (Array.isArray(saved)) await update($, collapsed, () => saved.filter((k: unknown): k is string => typeof k === 'string'))
    } catch { /* nothing folded yet */ }
    // A reload mid-check leaves no check running, whatever the session's value says.
    await update($, busy, () => false)
    const first = await refresh($)
    if (first.items.length > 0) void openPane($)
    $.clock.every(60000, () => refresh($))
    return next(e)
  })

  on('command.run', { command: 'pending-items' }, async $ => {
    await refresh($)
    await openPane($)
    return { text: '待處理單據面板已打開。' }
  })

  // A prompt asking to see an OwnMind task card or bug report gets the item in full attached, so
  // the model answers from the item itself. Only a prompt the person sent themself counts (from
  // the prompt box, here or through a remote control): a background task's notice, another
  // session's message or another plugin's prompt that happens to quote the request must not pull
  // a colleague's report into the turn. A slash command and a meta prompt are left alone too.
  on('prompt.submit', async ($, e: any, next) => {
    const kind = e?.origin?.kind
    if ((kind !== 'composer' && kind !== 'bridge') || e.command || e.isMeta) return next(e)
    const asked = requestedIn(String(e.text ?? ''))
    if (!asked) return next(e)
    const text = (await runScript($, 'pending-items-show.js', [asked.kind, asked.id], 10000))?.trim()
    return text ? next({ ...e, context: [...(e.context ?? []), text] }) : next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select, Svg } = $.ui.resolve(e) as any
    const graphical = e.surface !== 'terminal'
    const v = await read($, view)
    const chosen = await read($, filter)
    const folded = new Set(await read($, collapsed))
    const isBusy = await read($, busy)
    const groups = groupItems(v.items)
    // A project whose items are all done leaves the list; the select then falls back to every
    // project instead of keeping an empty pane with no way out.
    const pick = groups.some(g => g.key === chosen) ? chosen : ''
    const shown = groups.filter(g => !pick || g.key === pick)
    const count = shown.reduce((n, g) => n + g.items.length, 0)
    const time = clockTime(v.checkedAt)

    // Read the folds at press time, not from this drawing, so quick presses on two groups both count.
    const toggle = async (key: string) => {
      const now = await read($, collapsed)
      const next = now.includes(key) ? now.filter(k => k !== key) : [...now, key]
      await update($, collapsed, () => next)
      await saveFolds($, next)
    }

    // The terminal has no Svg element: it draws the name instead.
    const logo = (source: Item['source']) => {
      return graphical && Svg
        ? <Svg source={LOGO[source].svg} alt={LOGO[source].name} width={14} height={14} />
        : <Text dimColor>{LOGO[source].name}</Text>
    }

    // Who the card names (its opener, author or last commenter; the user themself and bots
    // included), as initials. `isInteractive` is what lets the Svg's <title> show as a tooltip.
    // The terminal has no Svg: it draws the letters in the person's colour.
    const avatar = (name: string) => {
      const text = initials(name)
      if (!text) return null
      return graphical && Svg
        ? <Svg source={avatarSvg(text, name)} alt={name} width={20} height={20} isInteractive />
        : <Text color={dotOf(name)} weight="semibold">{text}</Text>
    }

    // A card: who it names, the title and the number on one row; then the age, with the hide
    // control at the row's end. No label says why the item waits (review, failing tests, a new
    // reply): the product owner asked for the cards without them.
    const card = (i: Item) => {
      const d = daysAgo(i.at)
      const stale = d !== null && d > STALE_DAYS
      // A Button holds only text, so the hide control is an emoji, at the footer's own text size
      // so the row keeps its height when it appears. No `label`: the desktop draws a label in
      // place of the children.
      const hide = <Button key={`hide:${i.key}:${i.kind}`} plain onPress={() => hideItem($, i)}><Text size="footnote">{HIDE_GLYPH}</Text></Button>
      // The control shows only while the pointer is on the card (the keyed Box that scopes the
      // hover), in a slot kept for it at the end of the last row: the row never shifts when it
      // appears, and it lies over nothing. The terminal has no such reveal and always draws it.
      const slot = (
        <Box width={HIDE_SLOT} flexShrink={0} flexDirection="row" justifyContent="flex-end">
          {graphical ? <Box display="none" hover={{ display: 'flex' }}>{hide}</Box> : hide}
        </Box>
      )
      const who = avatar(i.person)
      // The title opens the item (a GitHub or GitLab item in the browser; an OwnMind one as a request
      // in the prompt box), drawn as plain text: a Link is blue and underlined, and as an
      // inline anchor it ran a title just over one line long past the card's edge. Only a Button
      // can be pressed and it holds only text, so the card as a whole cannot open the item; the
      // title alone does. The desktop cuts a long title to one line. Showing the whole of it on
      // hover was tried and dropped: no element here takes a tooltip but Svg, a strip laid over
      // the card hid what was above it, and one in the flow made the card jump under the pointer.
      const request = requestFor(i.key)
      const press = request ? () => toPromptBox($, request) : i.url ? () => openUrl($, i.url) : null
      const title = press
        ? <Button key={`card:${i.key}:${i.kind}`} plain onPress={press}><Text weight="semibold" wrap="wrap">{i.title}</Text></Button>
        : <Text weight="semibold" wrap="wrap">{i.title}</Text>
      return (
        <Box key={`body:${i.key}:${i.kind}`} flexDirection="column" gap="xs" paddingX="sm" paddingY="xs" overflow="hidden" {...(graphical ? { backgroundColor: CARD_BG, hover: { backgroundColor: CARD_HOVER } } : { borderStyle: 'round', borderColor: 'subtle' })}>
          <Box flexDirection="row" alignItems="center" gap="sm" width="100%" minWidth={0}>
            {/* Beside a long title the row is short of room: the circle must not be the part that gives way. */}
            {who && <Box flexShrink={0}>{who}</Box>}
            <Box flexGrow={1} flexShrink={1} minWidth={0}>{title}</Box>
            <Box flexShrink={0}><Text size="footnote" mono dimColor>{shortRef(i.ref)}</Text></Box>
          </Box>
          <Box flexDirection="row" alignItems="center" gap="sm">
            {d !== null && <Text size="footnote" tabular color={stale ? 'warning' : undefined} dimColor={!stale} weight={stale ? 'medium' : undefined}>{ageText(d)}</Text>}
            <Box flexGrow={1} />
            {slot}
          </Box>
        </Box>
      )
    }

    const lane = (g: Group) => {
      const open = !folded.has(g.key)
      return (
        <Box key={`lane:${g.key}`} flexDirection="column" gap="xs" padding="sm" {...(graphical ? { backgroundColor: LANE_BG } : {})}>
          <Box flexDirection="row" alignItems="center" gap="xs">
            <Button key={`fold:${g.key}`} plain onPress={() => toggle(g.key)}>
              <Text dimColor>{open ? '▾' : '▸'}</Text> <Text color={dotOf(g.project)}>●</Text> <Text weight="semibold">{groupName(g)}</Text>
            </Button>
            {logo(g.source)}
            <Box flexGrow={1} />
            <Text size="footnote" color="suggestion" tabular weight="medium" {...(graphical ? { backgroundColor: COUNT_BG } : {})}> {g.items.length} </Text>
          </Box>
          {open && g.items.map(card)}
        </Box>
      )
    }

    const options = [
      { value: '', label: `全部（${v.items.length}）` },
      ...groups.map(g => ({ value: g.key, label: `${groupName(g)}（${g.items.length}）` })),
    ]

    return (
      <Box flexDirection="column" gap="sm">
        {/* The pane's own title bar already names it, so the first row is the select and the button. */}
        <Box flexDirection="row" alignItems="center" gap="sm">
          {groups.length > 1
            ? <Box flexGrow={1}><Select key="project" value={pick} options={options} onSelect={(value: string) => update($, filter, () => value)} /></Box>
            : <Box flexGrow={1} />}
          <Button key="refresh" onPress={() => checkNow($)}>{isBusy ? '更新中…' : '更新'}</Button>
        </Box>
        {v.items.length === 0 && (
          <Text dimColor>{v.isLoaded ? '目前沒有等你處理的單' : '還沒有查過 GitHub、GitLab，下一次開對話時會查'}</Text>
        )}
        {v.items.length > 0 && shown.length === 0 && <Text dimColor>這個專案目前沒有等你處理的單</Text>}
        {shown.map(lane)}
        {time && <Text size="footnote" dimColor>最後檢查時間 {time}</Text>}
      </Box>
    )
  })
}
