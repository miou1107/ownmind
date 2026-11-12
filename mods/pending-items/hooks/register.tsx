import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Item, View } from '../types'

// The issues, PRs and MRs waiting on the user (issue #203), as a board: one group per project,
// a card per item. The session-start and prompt hooks do the checking and keep the full list in
// ~/.ownmind/state/pending-items.json; this pane reads that file, and its refresh button runs
// the same check once more through hooks/pending-items-check.js.
const PANE = 'pending-items'
const TITLE = '待處理單據'
const STALE_DAYS = 14

const EMPTY: View = { items: [], checkedAt: '', isLoaded: false }
// v1.33.5: items gained project, source and at. The new tag drops what v1.33.4 stored.
const view = atom({ plugin: 'pending-items', key: 'view' } as const, EMPTY, { shape: 'view-2' })
const filter = atom({ plugin: 'pending-items', key: 'filter' } as const, '', { shape: 'filter-1' })
const collapsed = atom({ plugin: 'pending-items', key: 'collapsed' } as const, [] as string[], { shape: 'collapsed-1' })
const busy = atom({ plugin: 'pending-items', key: 'busy' } as const, false, { shape: 'busy-1' })

// Only the states that differ from a plain assignment get a label; every card in the pane is
// already waiting on the user, so a "pending" label on each would say nothing.
const LABEL: Partial<Record<Item['kind'], string>> = { review: '待審核', failing: '測試未通過', comment: '待回覆' }
const TONE: Partial<Record<Item['kind'], string>> = { review: 'warning', failing: 'error', comment: 'suggestion' }
// Waiting first, then the newest change.
const ORDER: Record<Item['kind'], number> = { review: 0, failing: 1, comment: 2, assigned: 3 }

// A dot per project, picked from the name so a project keeps its colour between sessions.
// Theme colours: the desktop draws a Text's colour from the theme, not from a hex value.
const DOTS = ['suggestion', 'success', 'merged', 'warning', 'claude', 'ide', 'permission', 'planMode', 'autoAccept', 'remember']
const hashOf = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)
const dotOf = (name: string) => DOTS[hashOf(name) % DOTS.length]

// Simple Icons' marks (CC0). GitHub's in a grey that reads on light and dark panes alike.
const GITHUB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#8b949e" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
const GITLAB_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="#FC6D26" d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z"/></svg>'

// The pane cannot tell a light app from a dark one, so the fills are a translucent grey that
// reads on both: a faint one for the project group, a firmer one for each card on top of it.
// The terminal draws a card as a rounded border instead.
const LANE_BG = 'rgba(127,127,127,0.10)'
// The theme's inverse-text colour is the app's own page colour: white cards in a light app,
// dark cards in a dark one, each standing out from the grey group behind it.
const CARD_BG = 'inverseText'
const CARD_HOVER = 'rgba(127,127,127,0.08)'
// Tinted pills, as on a kanban card: a faint fill in the label's own hue.
const PILL: Partial<Record<Item['kind'], string>> = { review: 'rgba(234,179,8,0.18)', failing: 'rgba(239,68,68,0.16)', comment: 'rgba(59,130,246,0.16)' }
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
const avatarSvg = (text: string, name: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle cx="10" cy="10" r="10" fill="${AVATAR_FILLS[hashOf(name) % AVATAR_FILLS.length]}"/>` +
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

/** `owner/repo issue #68` -> `#68`, `owner/repo PR #7` -> `PR #7`, `g/p#112` -> `#112`, `g/p!4` -> `!4`. */
export const shortRef = (ref: string) => {
  const gh = /\s(issue|PR)\s#(\d+)$/.exec(ref)
  if (gh) return gh[1] === 'PR' ? `PR #${gh[2]}` : `#${gh[2]}`
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

const KINDS = new Set(['assigned', 'review', 'failing', 'comment'])

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
          source: String(i.host || i.key).startsWith('github') ? 'github' : 'gitlab',
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

const refresh = async ($: any) => {
  let next = EMPTY
  try {
    next = parseState(await $.fs.read(await statePath($)))
  } catch { /* no file yet: nothing has been checked on this machine */ }
  await update($, view, () => next)
  return next
}

// The refresh button: ask GitHub and GitLab again, then reread the file. Node may not be on
// the desktop app's PATH, so the usual install places are tried after it, Windows' included.
const NODES = ['node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node', 'C:\\Program Files\\nodejs\\node.exe']
// $.process.run rejects both when the program cannot start and when it outlives its timeout.
// Only the first means "try the next place"; a check that ran out of time is not retried.
const isTimeout = (err: unknown) => /time(d)?\s*out|timeout/i.test(String((err as any)?.message ?? err))
let running = false
const checkNow = async ($: any) => {
  // A plain flag, set before any await, so two quick presses start one check.
  if (running) return
  running = true
  await update($, busy, () => true)
  try {
    const script = joinPath(await homeDir($), '.ownmind', 'hooks', 'pending-items-check.js')
    for (const node of NODES) {
      try {
        await $.process.run([node, script], { timeoutMs: 30000 })
        break
      } catch (err) {
        if (isTimeout(err)) break
      }
    }
    await refresh($)
  } finally {
    running = false
    await update($, busy, () => false)
  }
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
    const logo = (source: Item['source']) =>
      graphical && Svg
        ? <Svg source={source === 'github' ? GITHUB_SVG : GITLAB_SVG} alt={source === 'github' ? 'GitHub' : 'GitLab'} width={14} height={14} />
        : <Text dimColor>{source === 'github' ? 'GitHub' : 'GitLab'}</Text>

    // Who is waiting, as initials. The terminal has no Svg: it draws the letters in the person's colour.
    const avatar = (name: string) => {
      const text = initials(name)
      if (!text) return null
      return graphical && Svg
        ? <Svg source={avatarSvg(text, name)} alt={name} width={20} height={20} />
        : <Text color={dotOf(name)} weight="semibold">{text}</Text>
    }

    const card = (i: Item) => {
      const d = daysAgo(i.at)
      const stale = d !== null && d > STALE_DAYS
      const label = LABEL[i.kind]
      return (
        <Box key={`body:${i.key}:${i.kind}`} flexDirection="column" gap="xs" paddingX="sm" paddingY="xs" overflow="hidden" {...(graphical ? { backgroundColor: CARD_BG, hover: { backgroundColor: CARD_HOVER } } : { borderStyle: 'round', borderColor: 'subtle' })}>
          {label && (
            <Box flexDirection="row">
              <Text size="caption" color={TONE[i.kind]} weight="medium" {...(graphical ? { backgroundColor: PILL[i.kind] } : {})}> {label} </Text>
            </Box>
          )}
          {/* The title opens the item, drawn as plain text: a Link is blue and underlined, and as an
              inline anchor it ran a title just over one line long past the card's edge. A Button
              holds only text, so the title is the part of the card that can be pressed. */}
          <Box width="100%" minWidth={0}>
            {i.url
              ? <Button key={`card:${i.key}:${i.kind}`} plain onPress={() => openUrl($, i.url)}><Text weight="semibold" wrap="wrap">{i.title}</Text></Button>
              : <Text weight="semibold" wrap="wrap">{i.title}</Text>}
          </Box>
          <Box flexDirection="row" alignItems="center" gap="sm">
            <Text size="footnote" mono dimColor>{shortRef(i.ref)}</Text>
            <Box flexGrow={1} />
            {d !== null && <Text size="footnote" tabular color={stale ? 'warning' : undefined} dimColor={!stale} weight={stale ? 'medium' : undefined}>{ageText(d)}</Text>}
            {avatar(i.person)}
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
              <Text dimColor>{open ? '▾' : '▸'}</Text> <Text color={dotOf(g.project)}>●</Text> <Text weight="semibold">{g.project}</Text>
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
      ...groups.map(g => ({ value: g.key, label: `${g.project}（${g.items.length}）` })),
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
