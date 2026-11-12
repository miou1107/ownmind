import { test, expect } from 'claude-code/testing'
import { HIDE_GLYPH, initials, requestFor, requestedIn } from './register'

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

test('the pane groups cards by project, with the place logo and the age; no card carries a label', async ($, on) => {
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
    // No card carries a label: the caption-sized pill is gone.
    expect((await ui.findAll({ type: 'Text' })).filter((x: any) => x.props?.size === 'caption').length).toBe(0)
    expect(await ui.find({ type: 'Text', text: /^今天$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\d+ 天前$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^#12$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^!112$/ })).toBeDefined()
    // A GitHub pull request is numbered as a merge request is.
    expect(await ui.find({ type: 'Text', text: /^!401$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /最後檢查時間/ })).toBeDefined()
    if (surface === 'desktop') {
      // Three place logos, and a circle with initials for each card that names who is waiting.
      expect((await ui.findAll({ type: 'Svg' })).map((s: any) => s.props.alt).sort()).toEqual(['GitHub', 'GitHub', 'GitLab', 'Jane Doe', 'reviewer'])
      const jane = (await ui.findAll({ type: 'Svg' })).find((s: any) => s.props.alt === 'Jane Doe')
      expect(jane.props.source).toContain('>JD</text>')
      // The full name is the Svg's <title>, which an interactive Svg shows as a tooltip.
      expect(jane.props.source).toContain('<title>Jane Doe</title>')
      expect(jane.props.isInteractive).toBe(true)
      // The circle keeps clear of the image's edge, and sits in a box that does not shrink beside a long title.
      expect(jane.props.source).toContain('r="9.5"')
      const holders = (await ui.findAll({ type: 'Box' })).filter((b: any) => b.props?.flexShrink === 0 && b.children?.length === 1 && b.children[0].type === 'Svg')
      expect(holders.length).toBe(2)
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
  // The title is the card's only link: one such button per card, the number and the age plain text.
  const opened = (await ui.findAll({ type: 'Button' })).filter((b: any) => !/^(hide|fold):|^(refresh)$/.test(String(b.key ?? b.props?.key ?? '')))
  expect(opened.length).toBe(4)
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
    expect(await ui.find({ type: 'Text', text: /^#32$/ })).toBeDefined()
    if (surface === 'desktop') {
      expect((await ui.findAll({ type: 'Svg' })).map((s: any) => s.props.alt)).toEqual(['OwnMind', 'OwnMind'])
    } else {
      expect((await ui.findAll({ type: 'Text', text: /^OwnMind$/ })).length).toBe(2)
    }
    await ui.unmount()
  }
})

test('hiding a card asks first; a yes drops the card for good, a no keeps it', async ($, on) => {
  const o = on as any
  const asked: any[] = []
  const written: Record<string, string> = {}
  let answer = '取消'
  o('tool.call', (_: any, e: any) => {
    asked.push(e)
    return { result: { questions: e.questions, answers: { [e.questions[0].question]: answer } } }
  })
  o('fs.write', (_: any, e: any) => { written[e.path] = e.text; return { value: undefined } })
  o('ui.open', () => ({ value: { isPlaced: true } }))
  stub(o, p => (p.endsWith('pending-items.json') ? { value: STATE } : written[p] ? { value: written[p] } : { deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })
  // One hide mark per card, drawn as a glyph.
  const marks = (await ui.findAll({ type: 'Button' })).filter((b: any) => String(b.key ?? b.props?.key ?? '').startsWith('hide:'))
  expect(marks.length).toBe(4)
  // The mark is the button's only text: a desktop draws a `label` in place of its children.
  for (const m of marks) expect(m.props?.label ?? m.text).toBe(HIDE_GLYPH)
  // On the desktop each mark waits in a hidden box, shown on hover. The box is in the flow, inside
  // a slot of fixed width, so it never lies over the title and showing it moves nothing.
  const boxes = await ui.findAll({ type: 'Box' })
  const reveals = boxes.filter((b: any) => b.props?.display === 'none')
  expect(reveals.length).toBe(4)
  for (const r of reveals) expect(r.props.position).toBeUndefined()
  const slots = boxes.filter((b: any) => b.props?.width === 3 && b.props?.flexShrink === 0)
  expect(slots.length).toBe(4)
  await ui.press({ key: 'hide:github:example/api#401:review' })
  expect(asked.length).toBe(1)
  expect(asked[0].tool).toBe('AskUserQuestion')
  expect(asked[0].questions[0].question).toContain('Monthly quota cap')
  expect(asked[0].questions[0].options.map((x: any) => x.label)).toEqual(['隱藏', '取消'])
  expect((await cards(ui)).length).toBe(4)
  expect(Object.keys(written).length).toBe(0)
  answer = '隱藏'
  await ui.press({ key: 'hide:github:example/api#401:review' })
  expect((await cards(ui)).length).toBe(3)
  expect(await ui.find({ key: 'card:github:example/api#401:review' })).toBeUndefined()
  const file = Object.keys(written)[0]!
  expect(file).toBe('/home/test/.ownmind/state/pending-items-hidden.json')
  expect(JSON.parse(written[file]!).hidden.map((h: any) => [h.key, h.title])).toEqual([['github:example/api#401', 'Monthly quota cap']])
  // A second item is added to the list, not written over it.
  await ui.press({ key: 'hide:github:example/api#12:assigned' })
  expect(JSON.parse(written[file]!).hidden.map((h: any) => h.key)).toEqual(['github:example/api#401', 'github:example/api#12'])
  expect((await cards(ui)).length).toBe(2)
  await ui.unmount()
})

test('an item hidden earlier has no card, and a pane with nothing else left stays closed', async ($, on) => {
  const o = on as any
  const opened: any[] = []
  const one = JSON.stringify({ lastCheckAt: now, items: [JSON.parse(STATE).items[0]] })
  const hidden = JSON.stringify({ hidden: [{ key: 'github:example/api#401', title: 'Monthly quota cap', at: now }] })
  o('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  stub(o, p => (p.endsWith('pending-items.json') ? { value: one } : p.endsWith('pending-items-hidden.json') ? { value: hidden } : { deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  expect(opened.length).toBe(0)
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })
  expect((await cards(ui)).length).toBe(0)
  expect(await ui.find({ type: 'Text', text: /目前沒有等你處理的單/ })).toBeDefined()
  await ui.unmount()
})

test('an OwnMind title puts a request in the prompt box, and sending it hands the model the item in full', async ($, on) => {
  const o = on as any
  const state = JSON.stringify({ lastCheckAt: now, items: [
    { key: 'ownmind:task#3', kind: 'task', title: 'Write the guide', url: 'https://om.example.com/dashboard/inbox/tasks', ref: 'task #3', project: 'web', host: 'ownmind', at: now, person: 'Jane Doe' },
    { key: 'ownmind:bug#32', kind: 'bug', title: 'Login loop', url: 'https://om.example.com/dashboard/inbox/bugs', ref: 'bug #32', project: '#reports', host: 'ownmind', at: now, person: 'Sam Wu' },
  ] })
  const fills: any[] = []
  const runs: string[][] = []
  const sent: any[] = []
  let draft = ''
  o('prompt.fill', (_: any, e: any) => { fills.push(e); return { isFilled: true } })
  o('prompt.read', () => ({ value: { text: draft, cursor: draft.length } }))
  o('prompt.submit', (_: any, e: any) => { sent.push(e); return { text: e.text } })
  o('process.run', (_: any, e: any) => { runs.push([...e.argv]); return { value: { exitCode: 0, stdout: '[OwnMind] Task card #3. Title: Write the guide\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  o('ui.open', () => ({ value: { isPlaced: true } }))
  stub(o, p => (p.endsWith('pending-items.json') ? { value: state } : { deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })

  // The title asks in the conversation; it does not open a web page.
  await ui.press({ key: 'card:ownmind:task#3:task' })
  expect(runs.length).toBe(0)
  expect(fills.length).toBe(1)
  expect(fills[0].text).toBe(requestFor('ownmind:task#3'))
  expect(fills[0].text).toContain('#3')
  expect(fills[0].mode ?? 'replace').toBe('replace')
  // With a draft already in the box, the request goes after it.
  draft = 'half a sentence'
  await ui.press({ key: 'card:ownmind:bug#32:bug' })
  expect(fills[1].mode).toBe('append')
  expect(fills[1].text).toBe(`\n${requestFor('ownmind:bug#32')}`)
  await ui.unmount()

  // Sending the request runs the script that reads the item and attaches what it printed.
  const asPerson = { origin: { kind: 'composer' } }
  await ($ as any).prompt.submit({ text: requestFor('ownmind:task#3'), ...asPerson })
  expect(runs.length).toBe(1)
  expect(runs[0]!.slice(1)).toEqual(['/home/test/.ownmind/hooks/pending-items-show.js', 'task', '3'])
  expect(sent[0].context).toEqual(['[OwnMind] Task card #3. Title: Write the guide'])
  // Any other prompt goes through untouched, and nothing is run for it.
  await ($ as any).prompt.submit({ text: 'What is waiting on me today?', ...asPerson })
  expect(runs.length).toBe(1)
  expect(sent[1].context ?? []).toEqual([])
  // The same words from anyone but the person at the prompt box run nothing: a background
  // task's notice, another session, another plugin, a slash command.
  for (const other of [{ origin: { kind: 'task-notification' } }, { origin: { kind: 'peer' } }, { origin: { kind: 'plugin', name: 'x' } }, { origin: { kind: 'sdk' } }, {}, { ...asPerson, isMeta: true }]) {
    await ($ as any).prompt.submit({ text: requestFor('ownmind:bug#32'), ...other })
  }
  expect(runs.length).toBe(1)
  expect(sent.slice(2).every((e: any) => (e.context ?? []).length === 0)).toBe(true)

  expect(requestFor('github:example/api#401')).toBe('')
  expect(requestedIn(requestFor('ownmind:bug#32'))).toEqual({ kind: 'bug', id: '32' })
  // After a draft, on a line of its own, as the pane appends it.
  expect(requestedIn(`half a sentence\n${requestFor('ownmind:task#12')}`)).toEqual({ kind: 'task', id: '12' })
  // A mention inside other text is not a request, nor is a number too long to be an id.
  expect(requestedIn(`the review says ${requestFor('ownmind:task#12')} was attached`)).toBeNull()
  expect(requestedIn(requestFor('ownmind:task#12345678901234567890'))).toBeNull()
  expect(requestedIn('OwnMind #3')).toBeNull()
})

test('a hidden list that cannot be read is never written over', async ($, on) => {
  const o = on as any
  const written: Record<string, string> = {}
  const toasts: string[] = []
  o('tool.call', (_: any, e: any) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: e.questions[0].options[0].label } } }))
  o('fs.write', (_: any, e: any) => { written[e.path] = e.text; return { value: undefined } })
  o('fs.exists', (_: any, e: any) => ({ value: String(e.path).endsWith('pending-items-hidden.json') }))
  o('ui.toast', (_: any, e: any) => { toasts.push(String(e.text ?? '')); return { value: undefined } })
  o('ui.open', () => ({ value: { isPlaced: true } }))
  // Half written by another window: the earlier items are in there somewhere.
  stub(o, p => (p.endsWith('pending-items.json') ? { value: STATE } : p.endsWith('pending-items-hidden.json') ? { value: '{"hidden":[{"key":"github:example/web#50"' } : { deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'hide:github:example/api#401:review' })
  expect(Object.keys(written).length).toBe(0)
  expect(toasts.length).toBe(1)
  expect((await cards(ui)).length).toBe(4)
  await ui.unmount()
})

test('a hidden list written as bare keys still hides, and keeps those keys when another is added', async ($, on) => {
  const o = on as any
  const written: Record<string, string> = {}
  o('tool.call', (_: any, e: any) => ({ result: { questions: e.questions, answers: { [e.questions[0].question]: e.questions[0].options[0].label } } }))
  o('fs.write', (_: any, e: any) => { written[e.path] = e.text; return { value: undefined } })
  o('ui.open', () => ({ value: { isPlaced: true } }))
  stub(o, p => (p.endsWith('pending-items.json') ? { value: STATE } : p.endsWith('pending-items-hidden.json') ? { value: written[p] ?? '{"hidden":["github:example/web#50"]}' } : { deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  const ui: any = await ($ as any).ui.mount({ ...PANE, surface: 'desktop' })
  expect((await cards(ui)).length).toBe(3)
  await ui.press({ key: 'hide:github:example/api#401:review' })
  expect(JSON.parse(Object.values(written)[0]!).hidden.map((h: any) => h.key)).toEqual(['github:example/web#50', 'github:example/api#401'])
  expect((await cards(ui)).length).toBe(2)
  await ui.unmount()
})
