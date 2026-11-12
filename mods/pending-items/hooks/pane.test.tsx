import { test, expect } from 'claude-code/testing'

// Invented repositories only: this repository is public.
const STATE = JSON.stringify({
  day: '2026-11-13',
  lastCheckAt: '2026-11-13T15:40:00+08:00',
  items: [
    { key: 'github:example/api#401', kind: 'review', title: 'Monthly quota cap', url: 'https://github.com/example/api/pull/401', ref: 'example/api PR #401' },
    { key: 'github:example/web#50', kind: 'failing', title: 'Skip button', url: 'https://github.com/example/web/pull/50', ref: 'example/web PR #50' },
  ],
})

const stub = (o: any, fsRead: (path: string) => any) => {
  const v = (x: any) => () => ({ value: x })
  o('session.start', () => ({ cwd: '/tmp' }))
  o('command.register', v({ command: 'x' }))
  o('clock.every', v({}))
  o('env.get', v('/home/test'))
  o('fs.read', (_: any, e: any) => fsRead(String(e.path ?? '')))
}

test('the pane lists every waiting item with a link, and opens itself when there are any', async ($, on) => {
  const o = on as any
  const opened: any[] = []
  o('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  stub(o, p => (p.endsWith('pending-items.json') ? { value: STATE } : { deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  expect(opened.length).toBe(1)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui: any = await ($ as any).ui.mount({ plugin: 'pending-items', surface, component: 'Pane', requestId: 'pending-items', props: { bodyColumns: 60 } })
    expect(await ui.find({ type: 'Text', text: /待處理單據　2 張/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /測試未通過/ })).toBeDefined()
    expect(await ui.find({ type: 'Link' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /最後檢查時間/ })).toBeDefined()
    await ui.unmount()
  }
})

test('no state file: the pane stays closed and says nothing has been checked yet', async ($, on) => {
  const o = on as any
  const opened: any[] = []
  o('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  stub(o, () => ({ deny: 'missing' }))
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  expect(opened.length).toBe(0)
  const ui: any = await ($ as any).ui.mount({ plugin: 'pending-items', surface: 'desktop', component: 'Pane', requestId: 'pending-items', props: { bodyColumns: 60 } })
  expect(await ui.find({ type: 'Text', text: /還沒有查過/ })).toBeDefined()
  await ui.unmount()
})
