import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Item, View } from '../types'

// v1.33.4 (issue #203) — the issues, PRs and MRs waiting on the user. The session-start and
// prompt hooks do the checking and keep the full list in ~/.ownmind/state/pending-items.json;
// this pane only reads that file, so it never asks GitHub or GitLab anything itself.
const PANE = 'pending-items'
const TITLE = '待處理單據'

const EMPTY: View = { items: [], checkedAt: '', isLoaded: false }
const view = atom({ plugin: 'pending-items', key: 'view' } as const, EMPTY, { shape: 'view-1' })

const LABEL: Record<Item['kind'], string> = {
  assigned: '待處理',
  review: '待審核',
  failing: '測試未通過',
  comment: '待回覆',
}
const COLOR: Record<Item['kind'], string> = {
  assigned: '#BA7517',
  review: '#BA7517',
  failing: '#E24B4A',
  comment: '#2a78d6',
}

const pad = (n: number) => String(n).padStart(2, '0')
const clockTime = (iso: string) => {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

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
      .map((i: any) => ({ key: i.key, kind: i.kind, title: String(i.title ?? ''), url: String(i.url ?? ''), ref: String(i.ref ?? '') }))
    return { items, checkedAt: String(s?.lastCheckAt ?? ''), isLoaded: true }
  } catch {
    return EMPTY
  }
}

const refresh = async ($: any) => {
  let next = EMPTY
  try {
    const file = joinPath(await homeDir($), '.ownmind', 'state', 'pending-items.json')
    next = parseState(await $.fs.read(file))
  } catch { /* no file yet: nothing has been checked on this machine */ }
  await update($, view, () => next)
  return next
}

const openPane = ($: any) => $.ui.open({ id: PANE, title: TITLE, closeOnEscape: true })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'pending-items', description: '打開待處理單據面板' })
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
    const { Box, Text, Link } = $.ui.resolve(e) as any
    const v = await read($, view)
    const time = clockTime(v.checkedAt)
    return (
      <Box flexDirection="column" gap={1}>
        <Text bold>{v.items.length > 0 ? `${TITLE}　${v.items.length} 張` : TITLE}</Text>
        {v.items.length === 0 && (
          <Text dimColor>{v.isLoaded ? '目前沒有等你處理的單' : '還沒有查過 GitHub、GitLab，下一次開對話時會查'}</Text>
        )}
        {v.items.map(i => (
          <Box flexDirection="column">
            <Text color={COLOR[i.kind]}>{LABEL[i.kind]}</Text>
            {i.url ? <Link href={i.url} label={`${i.title} ↗`} /> : <Text>{i.title}</Text>}
            <Text dimColor>{i.ref}</Text>
          </Box>
        ))}
        {time && <Text dimColor>最後檢查時間 {time}</Text>}
      </Box>
    )
  })
}
