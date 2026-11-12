import { test, expect } from 'claude-code/testing'
import { initials } from './register'

// Invented repositories only: this repository is public.
const now = new Date().toISOString()
const STATE = JSON.stringify({
  day: '2026-11-13',
  lastCheckAt: '2026-11-13T15:40:00+08:00',
  items: [
    { key: 'github:example/api#401', kind: 'review', title: 'Monthly quota cap', url: 'https://github.com/example/api/pull/401', ref: 'example/api PR #401', project: 'api', host: 'github', at: now, person: 'Jane Doe' },
    { key: 'github:example/api#12', kind: 'assigned', title: 'Old report', url: 'https://github.com/example/api/issues/12', ref: 'example/api issue #12', project: 'api', host: 'github', at: '2020-01-01T00:00:00Z' },
    { key: 'gitlab:https://git.example.com:g/p#112', kind: 'failing', title: 'Price warning', url: 'https://git.example.com/g/p/-/issues/112', ref: 'g/p!112', project: 'Billing', host: 'gitlab:https://git.example.com', at: now, person: 'reviewer' },
    // Written before items carried a project: the pane takes the repository's name from the ref.
    { key: 'github:example/web#50', kind: 'assigned', title: 'Skip button', url: 'https://github.com/example/web/issues/50', ref: 'example/web issue #50' },
  ],
})

const cards = async (ui: any) => (await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.key ?? b.props?.key ?? '').startsWith('card:'))

const PANE = { plugin: 'pending-items', component: 'Pane', requestId: 'pending-items', props: { bodyColumns: 60 } } as const

const stub = (o: any, fsRead: (path: string) => any) => {
  const v = (x: any) => () => ({ value: x })
  o('session.start', () => ({ cwd: '/tmp' }))
  o('command.register', v({ command: 'x' }))
  o('clock.every', v({}))
  o('env.get', v('/home/test'))
  o('fs.read', (_: any, e: any) => fsRead(String(e.path ?? '')))
}

const start = async ($: any, o: any, opened: any[] = []) => {
  o('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  stub(o, p => (p.endsWith('pending-items.json') ? { value: STATE } : { deny: 'missing' }))
  await $.session.start({ source: 'startup', cwd: '/tmp' })
}

test('the pane groups cards by project, with the place logo, the age and a label only where it differs', async ($, on) => {
  const opened: any[] = []
  await start($, on, opened)
  expect(opened.length).toBe(1)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui: any = await ($ as any).ui.mount({ ...PANE, surface })
    // api (2 items) first, then Billing and web; each group has its fold button.
    expect(await ui.find({ key: 'fold:github:api' })).toBeDefined()
    expect(await ui.find({ key: 'fold:gitlab:Billing' })).toBeDefined()
    expect(await ui.find({ key: 'fold:github:web' })).toBeDefined()
    expect((await cards(ui)).length).toBe(4)
    expect(await ui.find({ type: 'Text', text: /測試未通過/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /待審核/ })).toBeDefined()
    // A plain assignment carries no label.
    expect(await ui.find({ type: 'Text', text: /^待處理$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^今天$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\d+ 天前$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^#12$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^!112$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /最後檢查時間/ })).toBeDefined()
    if (surface === 'desktop') {
      // Three place logos, and a circle with initials for each card that names who is waiting.
      expect((await ui.findAll({ type: 'Svg' })).map((s: any) => s.props.alt).sort()).toEqual(['GitHub', 'GitHub', 'GitLab', 'Jane Doe', 'reviewer'])
      const jane = (await ui.findAll({ type: 'Svg' })).find((s: any) => s.props.alt === 'Jane Doe')
      expect(jane.props.source).toContain('>JD</text>')
    } else {
      expect(await ui.find({ type: 'Text', text: /^GitLab$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^JD$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^R$/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('a project folds and unfolds from its header, and the select shows one project', async ($, on) => {
  await start($, on)
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'fold:github:api' })
  expect((await cards(ui)).length).toBe(2)
  await ui.press({ key: 'fold:github:api' })
  expect((await cards(ui)).length).toBe(4)
  await ui.select({ key: 'project', value: 'gitlab:Billing' })
  expect((await cards(ui)).length).toBe(1)
  expect(await ui.find({ key: 'fold:github:api' })).toBeUndefined()
  await ui.select({ key: 'project', value: '' })
  expect((await cards(ui)).length).toBe(4)
  await ui.unmount()
})

test('the refresh button runs the check script and rereads the list', async ($, on) => {
  const o = on as any
  const runs: string[][] = []
  o('process.run', (_: any, e: any) => { runs.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  await start($, o)
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(runs.length).toBe(1)
  expect(runs[0]![1]).toBe('/home/test/.ownmind/hooks/pending-items-check.js')
  expect(await ui.find({ key: 'refresh', text: /^更新$/ })).toBeDefined()
  await ui.unmount()
})

test('a chosen project whose items are all done falls back to every project', async ($, on) => {
  const o = on as any
  let state = STATE
  o('ui.open', () => ({ value: { isPlaced: true } }))
  o('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  stub(o, p => (p.endsWith('pending-items.json') ? { value: state } : { deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })
  await ui.select({ key: 'project', value: 'gitlab:Billing' })
  expect((await cards(ui)).length).toBe(1)
  // The Billing item is done: the next check no longer lists it.
  const s = JSON.parse(STATE)
  s.items = s.items.filter((i: any) => i.project !== 'Billing')
  state = JSON.stringify(s)
  await ui.press({ key: 'refresh' })
  expect((await cards(ui)).length).toBe(3)
  expect(await ui.find({ key: 'fold:github:api' })).toBeDefined()
  await ui.unmount()
})

test('pressing a card title opens the item in the browser', async ($, on) => {
  const o = on as any
  const runs: string[][] = []
  o('process.run', (_: any, e: any) => { runs.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  await start($, o)
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Link' })).toBeUndefined()
  await ui.press({ key: 'card:github:example/api#401:review' })
  expect(runs).toEqual([['open', 'https://github.com/example/api/pull/401']])
  await ui.unmount()
})

test('no state file: the pane stays closed and says nothing has been checked yet', async ($, on) => {
  const o = on as any
  const opened: any[] = []
  o('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  stub(o, () => ({ deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  expect(opened.length).toBe(0)
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /還沒有查過/ })).toBeDefined()
  await ui.unmount()
})

test('initials: two letters for a full name, one for a login or a CJK name', async () => {
  expect(initials('Jane Doe')).toBe('JD')
  expect(initials('member4')).toBe('M')
  expect(initials('jane-doe')).toBe('JD')
  expect(initials('王小明')).toBe('王')
  expect(initials('  ')).toBe('')
  expect(initials('(Jane) Doe')).toBe('JD')
  expect(initials('ßanna Straße')).toBe('SS')
  expect(initials('🇹🇼 Taiwan')).toBe('T')
})

test('OwnMind task cards and bug reports get their own groups with the OwnMind logo', async ($, on) => {
  const o = on as any
  const state = JSON.stringify({ lastCheckAt: now, items: [
    { key: 'ownmind:task#3', kind: 'task', title: 'Write the guide', url: 'https://om.example.com/dashboard/inbox/tasks', ref: 'task #3', project: 'web', host: 'ownmind', at: now },
    { key: 'ownmind:bug#32', kind: 'resolved', title: 'Login loop', url: 'https://om.example.com/dashboard/inbox/reports', ref: 'bug #32', project: '#reports', host: 'ownmind', at: now },
  ] })
  o('ui.open', () => ({ value: { isPlaced: true } }))
  stub(o, p => (p.endsWith('pending-items.json') ? { value: state } : { deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui: any = await ($ as any).ui.mount({ ...PANE, surface })
    expect(await ui.find({ key: 'fold:ownmind:web' })).toBeDefined()
    expect(await ui.find({ key: 'fold:ownmind:#reports' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^問題回報$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /已解決/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^#32$/ })).toBeDefined()
    if (surface === 'desktop') {
      expect((await ui.findAll({ type: 'Svg' })).map((s: any) => s.props.alt)).toEqual(['OwnMind', 'OwnMind'])
    } else {
      expect((await ui.findAll({ type: 'Text', text: /^OwnMind$/ })).length).toBe(2)
    }
    await ui.unmount()
  }
})
