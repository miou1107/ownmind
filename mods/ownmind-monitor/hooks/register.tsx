import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Activity, Health, View, Week } from '../types'

const PANE = 'ownmind-monitor'
const TITLE = 'OwnMind 運作狀況'
const OWNMIND = 'mcp__ownmind__'
// Text a rule hook puts in front of a refusal: the OwnMind gate, the copy guard.
const RULE_BLOCK = /OwnMind|IR-\d+|鐵律|文案掃描|文案/
const DAY_MS = 86400000

const EMPTY_WEEK: Week = { days: [], sessions: [], lookups: [], violate: [], comply: [], updateFailed: [] }
const EMPTY: View = {
  memory: { isLoaded: false, version: '' },
  lookups: [],
  saves: 0,
  blocks: [],
  triggers: { total: 0, byKind: {} },
  health: { updateFailed: 0, judgeFailed: 0, server: 'idle', behind: 0, unreachable: false },
  week: EMPTY_WEEK,
  warned: '',
}

const view = atom({ plugin: 'ownmind-monitor', key: 'view' } as const, EMPTY)
const times = atom({ plugin: 'ownmind-monitor', key: 'times' } as const, {})

const pad = (n: number) => String(n).padStart(2, '0')
const clockTime = (ms: number) => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const localDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)

const SAVES = new Set(['ownmind_save', 'ownmind_update', 'ownmind_disable'])

// What one OwnMind call did, in the words the pane shows.
const describe = (tool: string, input: Record<string, unknown>) => {
  const name = tool.slice(OWNMIND.length)
  const q = String(input.query ?? input.title ?? input.rule_title ?? input.id ?? '')
  const quoted = q ? `「${clip(q, 24)}」` : ''
  switch (name) {
    case 'ownmind_search': return `查詢${quoted}`
    case 'ownmind_get': return `讀取記憶${quoted}`
    case 'ownmind_save': return `新增記憶${quoted}`
    case 'ownmind_update': return `更新記憶${quoted}`
    case 'ownmind_disable': return `停用記憶${quoted}`
    case 'ownmind_report_compliance': return `回報照做${quoted}`
    case 'ownmind_log_session': return '留下對話紀錄'
    case 'ownmind_init': return '重新載入記憶'
    default: return name.replace('ownmind_', '')
  }
}

const jsonLines = (text: string) =>
  text.split('\n').flatMap(line => {
    try { return line.trim() ? [JSON.parse(line)] : [] } catch { return [] }
  })

const readLog = async ($: any, path: string) => {
  try { return jsonLines(await $.fs.read(path)) } catch { return [] }
}

// The user's home folder. Windows may have no HOME at all, or a Git Bash form
// (/c/Users/x) that native file APIs cannot open; USERPROFILE is the real one there.
// Names are string literals: `claude plugin validate` reads them off the source.
const homeDir = async ($: any) => {
  const home = (await $.env.get('HOME')) ?? ''
  const profile = (await $.env.get('USERPROFILE')) ?? ''
  return profile && (!home || /^\/[a-zA-Z]\//.test(home)) ? profile : home
}

// Joins with the separator the home folder already uses, so a Windows path stays
// all-backslash and a POSIX one all-slash.
const joinPath = (base: string, ...parts: string[]) => {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep)
}

const readLogs = async ($: any) => {
  const home = await homeDir($)
  const now = await $.clock.now()
  const days = Array.from({ length: 7 }, (_, i) => localDay(now - (6 - i) * DAY_MS))
  const today = days[6]
  const ownmind = joinPath(home, '.ownmind')
  const dir = joinPath(ownmind, 'logs')
  // No usable home folder: show empty charts instead of reading /.ownmind.
  const isHomeUsable = home !== '' && !/^\/[a-zA-Z]\//.test(home)

  const week: Week = {
    days: days.map(shortDay),
    sessions: [], lookups: [], violate: [], comply: [], updateFailed: [],
  }
  const health: Health = { updateFailed: 0, judgeFailed: 0, server: 'idle', behind: 0, unreachable: false }
  for (const day of days) {
    const rows = isHomeUsable ? await readLog($, joinPath(dir, `${day}.jsonl`)) : []
    week.sessions.push(rows.filter(r => r.event === 'init').length)
    week.lookups.push(rows.filter(r => r.event === 'mcp_call' && r.tool === 'ownmind_search').length)
    const failed = rows.filter(r => r.event === 'update_failed').length
    week.updateFailed.push(failed)
    if (day === today) {
      health.updateFailed = failed
      // The updater logs step "fetch" when it cannot reach the update server at all. Then
      // origin/main is whatever the last successful fetch left, and `behind` is a guess.
      health.unreachable = rows.some(r => r.event === 'update_failed' && r.details?.step === 'fetch')
      const last = rows.filter(r => r.event === 'mcp_call').at(-1)
      if (last) health.server = last.details?.status === 'ok' ? 'ok' : 'down'
    }
  }
  const dayOf = (r: any) => (r.ts ? localDay(Date.parse(r.ts)) : '')
  const compliance = isHomeUsable ? await readLog($, joinPath(dir, 'compliance.jsonl')) : []
  for (const day of days) {
    const rows = compliance.filter(r => dayOf(r) === day)
    week.violate.push(rows.filter(r => r.action === 'violate').length)
    week.comply.push(rows.filter(r => r.action === 'comply').length)
  }
  const judge = isHomeUsable ? await readLog($, joinPath(dir, 'check-failures.jsonl')) : []
  health.judgeFailed = judge.filter(r => dayOf(r) === today).length

  // Versions this machine has not installed yet: release tags on the fetched
  // remote that the installed copy does not contain.
  if (isHomeUsable) try {
    const { exitCode, stdout } = await $.process.run(
      ['git', 'tag', '--no-merged', 'HEAD', '--merged', 'origin/main'],
      { cwd: ownmind, timeoutMs: 5000 })
    if (exitCode === 0) health.behind = stdout.split('\n').filter((t: string) => /^v\d/.test(t)).length
  } catch { /* git unavailable */ }

  return { week, health }
}

// The OwnMind hooks speak in the transcript: the session-start banner names the
// loaded version, and every rule check before an edit, a commit or a command adds
// a line naming the kind of operation it checked.
const KIND_NAMES: Record<string, string> = {
  'File edit': '改檔案',
  'Commit': 'commit',
  'Deploy': '部署',
  'Command': '執行指令',
}

const readTranscriptSignals = async ($: any) => {
  const memory = { ...EMPTY.memory }
  const byKind: Record<string, number> = {}
  let total = 0
  try {
    const api = await $.session.messages({ as: 'api' })
    if (Array.isArray(api)) {
      for (const m of api) {
        const blocks = typeof m.content === 'string' ? [{ text: m.content }] : m.content
        for (const b of blocks ?? []) {
          const text = String(b.text ?? b.content ?? '')
          if (!memory.isLoaded) {
            const hit = /\[OwnMind v([\d.]+)\] Memory loaded/.exec(text)
            if (hit) { memory.isLoaded = true; memory.version = hit[1] }
          }
          for (const t of text.matchAll(/\[OwnMind v[\d.]+\] This operation is a "([^"]+)" procedure/g)) {
            const kind = KIND_NAMES[t[1]] ?? t[1]
            byKind[kind] = (byKind[kind] ?? 0) + 1
            total += 1
          }
        }
      }
    }
  } catch { /* transcript unreadable */ }
  return { memory, triggers: { total, byKind } }
}

// Rebuilds the whole view from the transcript and the logs, so a reload or a
// mod loaded mid-session still counts what happened before it.
let lastWarned = ''

const refresh = async ($: any) => {
  const stamps = await read($, times)
  const lookups: Activity[] = []
  const blocks: Activity[] = []
  let saves = 0
  const msgs = await $.session.messages()
  if (Array.isArray(msgs)) {
    for (const m of msgs) {
      for (const use of m.toolUses ?? []) {
        const time = stamps[use.tool_use_id] ?? ''
        if (use.tool.startsWith(OWNMIND)) {
          if (SAVES.has(use.tool.slice(OWNMIND.length))) saves += 1
          lookups.push({ id: use.tool_use_id, time, label: describe(use.tool, use.input ?? {}) })
        } else if (use.isError && RULE_BLOCK.test(use.text ?? '')) {
          const first = (use.text ?? '').split('\n').find((l: string) => l.trim()) ?? ''
          blocks.push({ id: use.tool_use_id, time, label: clip(first.trim(), 60) })
        }
      }
    }
  }
  const [{ memory, triggers }, { week, health }] = await Promise.all([readTranscriptSignals($), readLogs($)])
  const prev = await read($, view)
  const next: View = { memory, lookups, saves, blocks, triggers, health, week, warned: prev.warned }

  // The update toast needs two things: today's attempts failed, and the installed
  // copy really is behind. A copy that is current despite the failures stays quiet.
  const trouble =
    health.updateFailed >= 3 && health.behind > 0 ? `OwnMind 今天自動更新失敗 ${health.updateFailed} 次，這台電腦的規矩還是舊版，落後 ${health.behind} 版。跟 AI 說「升級 OwnMind」就會修好`
    : health.judgeFailed >= 3 ? `OwnMind 回話檢查今天已失敗 ${health.judgeFailed} 次，有一部分回話沒被檢查到`
    : health.server === 'down' ? 'OwnMind 主機連不上，這段時間查不到記憶'
    : ''
  // Refreshes overlap (session start, every tool call, the /ownmind command), and each
  // one read `prev` before any of them wrote it back, so the same warning used to toast
  // once per overlapping refresh. The module-level key is set synchronously, before the
  // next refresh can reach this line.
  const key = trouble.replace(/\d+/g, '')
  if (trouble && key !== prev.warned && key !== lastWarned) {
    lastWarned = key
    $.ui.toast(trouble, { timeoutMs: 5000 })
  }
  next.warned = lastWarned || prev.warned
  await update($, view, () => next)

  $.ui.status(undefined)
}

// Chart colors: categorical slots 1 and 2, readable on light and dark panes.
const BLUE = '#2a78d6'
const ORANGE = '#eb6834'
const INK = '#888780'
const GRID = 'rgba(136,135,128,0.35)'

type Series = { name: string; color: string; values: number[] }

// A bar chart as one SVG document: grouped bars, or stacked when `isStacked`.
// Each day carries a <title>, so hovering a day shows its numbers.
const barChart = (days: string[], series: Series[], isStacked: boolean) => {
  const W = 360, H = 120, top = 8, left = 26, bottom = 18
  const plotH = H - top - bottom
  const slot = (W - left) / days.length
  const totals = days.map((_, i) =>
    isStacked ? sum(series.map(s => s.values[i])) : Math.max(...series.map(s => s.values[i])))
  const max = Math.max(1, ...totals)
  const y = (v: number) => top + plotH - (v / max) * plotH
  const parts: string[] = []
  for (const g of [0, Math.round(max / 2), max]) {
    parts.push(`<line x1="${left}" x2="${W}" y1="${y(g)}" y2="${y(g)}" stroke="${GRID}" stroke-width="0.5"/>`)
    parts.push(`<text x="${left - 4}" y="${y(g) + 4}" text-anchor="end" font-size="10" fill="${INK}">${g}</text>`)
  }
  days.forEach((day, i) => {
    const x0 = left + i * slot + 5
    const inner = slot - 10
    const width = isStacked ? inner : inner / series.length
    const tip = `${day}　${series.map(s => `${s.name} ${s.values[i]} 次`).join('，')}`
    parts.push(`<g><title>${tip}</title><rect x="${left + i * slot}" y="0" width="${slot}" height="${H}" fill="transparent"/>`)
    let base = top + plotH
    series.forEach((s, j) => {
      const h = (s.values[i] / max) * plotH
      if (h <= 0) return
      const x = isStacked ? x0 : x0 + j * width
      const yTop = isStacked ? base - h : top + plotH - h
      const drawn = isStacked ? Math.max(h - 2, 1) : h
      parts.push(`<rect x="${x}" y="${yTop}" width="${Math.max(width - 2, 2)}" height="${drawn}" rx="2" fill="${s.color}"/>`)
      if (isStacked) base -= h
    })
    parts.push(`<text x="${x0 + inner / 2}" y="${H - 4}" text-anchor="middle" font-size="10" fill="${INK}">${day}</text></g>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="sans-serif">${parts.join('')}</svg>`
}

// One sentence for "how far behind is this machine", shared by the card, the chart
// title and /ownmind-week so they never disagree.
const gapText = (h: Health) =>
  h.behind ? `這台電腦落後 ${h.behind} 版`
  : h.unreachable ? '今天連不上更新伺服器，查不到有沒有新版'
  : '已是最新版'

const weekSummary = async ($: any) => {
  const { week, health } = await readLogs($)
  const sessions = sum(week.sessions)
  const lookups = sum(week.lookups)
  const per = lookups ? Math.round(sessions / lookups) : 0
  const failed = sum(week.updateFailed)
  return [
    `**OwnMind 最近 7 天（${week.days[0]}–${week.days[6]}）**`,
    '',
    `- 開啟 ${sessions} 次對話，查詢 OwnMind ${lookups} 次${per > 1 ? `，平均 ${per} 次對話才查一次` : ''}`,
    `- commit 後檢查：漏做 ${sum(week.violate)} 次，照做 ${sum(week.comply)} 次`,
    `- 自動更新失敗 ${failed} 次${failed ? `，${gapText(health)}` : ''}`,
  ].join('\n')
}

const openPane = ($: any) =>
  $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true, holdToasts: true })

// Red only while OwnMind is not working right now: its memory never reached
// this conversation, or the last call to its server failed. Earlier update
// failures leave it green; the dashboard still shows them.
const needsLook = (v: View) => !v.memory.isLoaded || v.health.server === 'down'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ownmind', description: '打開 OwnMind 運作狀況面板' })
    await $.command.register({ name: 'ownmind-week', description: 'OwnMind 最近 7 天的運作狀況' })
    void refresh($)
    $.clock.every(60000, () => refresh($))
    return next(e)
  })

  on('command.run', { command: 'ownmind' }, async $ => {
    await openPane($)
    await refresh($)
    return { text: 'OwnMind 運作狀況面板已打開。' }
  })

  on('command.run', { command: 'ownmind-week' }, async $ => ({ text: await weekSummary($) }))

  on('tool.call', async ($, e, next) => {
    const time = clockTime(await $.clock.now())
    await update($, times, map => ({ ...map, [e.tool_use_id]: time }))
    const ran = await next(e)
    void refresh($)
    return ran
  })

  // A small button in the prompt footer, beside the session's mode labels.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const { Box, Button } = $.ui.resolve(e) as any
    const v = await read($, view)
    const engine = await next(e)
    return (
      <Box flexDirection="row" gap={1}>
        {engine}
        <Button key="ownmind-open" plain
          label={needsLook(v) ? '🔴 OwnMind' : '🟢 OwnMind'}
          onPress={() => openPane($)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e) as any
    const { Box, Text } = table
    const Svg = table.Svg
    const v = await read($, view)
    const green = '#3B6D11'
    const amber = '#BA7517'
    const red = '#E24B4A'
    const { week, health } = v
    const lookupsOnly = v.lookups.length - v.saves

    const card = (label: string, value: string, sub: string, color?: string) => (
      <Box flexDirection="column" flexGrow={1} width="48%" borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor>{label}</Text>
        <Text bold color={color}>{value}</Text>
        <Text dimColor>{sub}</Text>
      </Box>
    )

    const kinds = Object.entries(v.triggers.byKind).map(([k, n]) => `${k} ${n}`).join('、')
    const updateSub = gapText(health)

    const sessions = sum(week.sessions)
    const lookups = sum(week.lookups)
    const per = lookups ? Math.round(sessions / lookups) : 0
    const violate = sum(week.violate)
    const comply = sum(week.comply)
    const failed = sum(week.updateFailed)

    const charts = [
      {
        title: lookups === 0 ? '最近 7 天 AI 沒有查過 OwnMind'
          : per > 1 ? `AI 平均 ${per} 次對話才查一次 OwnMind` : 'AI 每次對話都有查 OwnMind',
        sub: '每天開啟的對話數與查詢 OwnMind 的次數',
        series: [
          { name: '開啟對話', color: BLUE, values: week.sessions },
          { name: '查詢 OwnMind', color: ORANGE, values: week.lookups },
        ],
        isStacked: false,
      },
      {
        title: comply >= violate
          ? `commit 後的檢查：照做 ${comply} 次，漏做 ${violate} 次`
          : `commit 後的檢查抓到漏做 ${violate} 次，照做只有 ${comply} 次`,
        sub: '每天 commit 後檢查的結果',
        series: [
          { name: '照做', color: BLUE, values: week.comply },
          { name: '漏做', color: ORANGE, values: week.violate },
        ],
        isStacked: true,
      },
      {
        title: failed === 0 ? '最近 7 天自動更新都沒有失敗'
          : `自動更新 7 天失敗 ${failed} 次，${gapText(health)}`,
        sub: '每天自動更新失敗的次數',
        series: [{ name: '自動更新失敗', color: BLUE, values: week.updateFailed }],
        isStacked: false,
      },
    ]

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" flexWrap="wrap" gap={1}>
          {card('記憶載入', v.memory.isLoaded ? '已載入' : '沒有載入', v.memory.isLoaded ? `v${v.memory.version}` : '這次對話開頭沒有看到記憶', v.memory.isLoaded ? green : red)}
          {card('這次對話查詢', `${lookupsOnly} 次`, `新增或更新記憶 ${v.saves} 筆`)}
          {card('規矩觸發・擋下', `${v.triggers.total}・${v.blocks.length}`, kinds || '還沒有觸發')}
          {card('今天自動更新', health.updateFailed ? `失敗 ${health.updateFailed} 次` : '正常', updateSub, health.updateFailed ? amber : green)}
        </Box>
        {week.days.length > 0 && charts.map(c => (
          <Box flexDirection="column">
            <Text bold>{c.title}</Text>
            <Text dimColor>{c.sub}</Text>
            {c.series.length > 1 && (
              <Text>
                {c.series.map(s => <Text color={s.color}>■ {s.name}　</Text>)}
              </Text>
            )}
            {Svg
              ? <Svg source={barChart(week.days, c.series, c.isStacked)} alt={c.title} isInteractive />
              : <Text dimColor>{c.series.map(s => `${s.name}：${s.values.join(' ')}`).join('　')}</Text>}
          </Box>
        ))}
        {v.lookups.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>這次對話查過的 OwnMind</Text>
            {v.lookups.slice(-6).map(a => <Text>{a.time || '  —  '}  {a.label}</Text>)}
          </Box>
        )}
        {v.blocks.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>這次對話被擋下的動作</Text>
            {v.blocks.slice(-5).map(a => <Text>{a.time || '  —  '}  {a.label}</Text>)}
          </Box>
        )}
      </Box>
    )
  })
}
