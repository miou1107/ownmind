import { test, expect } from 'claude-code/testing'

const day = (n: number) => `{"event":"init"}\n`.repeat(n) + `{"event":"mcp_call","tool":"ownmind_search","details":{"status":"ok"}}\n`

test('dashboard pane draws on desktop and terminal', async ($, on) => {
  const o = on as any
  const v = (x: any) => () => ({ value: x })
  o('session.start', () => ({ cwd: '/tmp' }))
  o('command.register', v({ command: 'x' }))
  const opened: any[] = []
  o('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  o('ui.status', v(undefined))
  o('ui.toast', v(undefined))
  o('clock.every', v({}))
  o('clock.now', v(Date.parse('2026-10-03T12:00:00+08:00')))
  o('env.get', v('/home/test'))
  o('fs.read', (_: any, e: any) => {
    const p = String(e.path ?? '')
    if (/\d{4}-\d\d-\d\d\.jsonl$/.test(p)) return { value: day(6) }
    return { deny: 'missing' }
  })
  o('process.run', v({ exitCode: 0, stdout: 'v1.30.41\nv1.30.42\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }))
  o('session.messages', v([{ role: 'user', text: '', toolUses: [], content: '[OwnMind v1.30.39] Memory loaded' }]))
  o('ui.render', { component: 'SessionMode' }, ($: any, e: any) => { const { Text } = $.ui.resolve(e); return <Text dimColor>Bypass permissions</Text> })
  await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui: any = await ($ as any).ui.mount({
      plugin: 'ownmind-monitor', surface, component: 'Pane', requestId: 'ownmind-monitor',
      props: { bodyColumns: 60 },
    })
    console.log(surface, JSON.stringify(await ui.find({ type: 'Text', text: /對話才查一次|沒有查過/ })))
    expect(await ui.find({ type: 'Text', text: /記憶載入/ })).toBeDefined()
    if (surface === 'desktop') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.unmount()
  }

  for (const surface of ['desktop', 'terminal'] as const) {
    const foot: any = await ($ as any).ui.mount({
      plugin: 'ownmind-monitor', surface, component: 'SessionMode', props: { modes: ['Bypass permissions'] },
    })
    const btn = await foot.find({ key: 'ownmind-open' })
    console.log(surface, 'footer button', JSON.stringify(btn?.props))
    expect(btn).toBeDefined()
    await foot.press({ key: 'ownmind-open' })
    await foot.unmount()
  }
  console.log('opened', JSON.stringify(opened))
  expect(opened.length).toBe(2)
})

// Windows: Claude Code started outside Git Bash has no HOME, and one started from Git Bash
// has HOME=/c/Users/x, which native file calls cannot open. Both must read the logs and run
// git from USERPROFILE.
for (const home of [undefined, '/c/Users/amy']) {
  test(`reads logs from USERPROFILE on Windows (HOME=${home ?? 'unset'})`, async ($, on) => {
    const o = on as any
    const v = (x: any) => () => ({ value: x })
    const env: Record<string, string | undefined> = { HOME: home, USERPROFILE: 'C:\\Users\\amy' }
    const reads: string[] = []
    const runs: any[] = []
    o('session.start', () => ({ cwd: 'C:\\work' }))
    o('command.register', v({ command: 'x' }))
    o('ui.status', v(undefined))
    o('ui.toast', v(undefined))
    o('clock.every', v({}))
    o('clock.now', v(Date.parse('2026-10-03T12:00:00+08:00')))
    o('env.get', (_: any, e: any) => ({ value: env[e.name] }))
    o('fs.read', (_: any, e: any) => { reads.push(String(e.path)); return { deny: 'missing' } })
    o('process.run', (_: any, e: any) => {
      runs.push(e)
      return { value: { exitCode: 0, stdout: 'v1.30.43\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    })
    o('session.messages', v([]))
    await ($ as any).session.start({ source: 'startup', cwd: 'C:\\work' })
    const res: any = await ($ as any).command.run({ command: 'ownmind-week', args: '' })
    expect(reads.length).toBeGreaterThan(0)
    // The harness runs on the test machine and resolves a path it does not recognise as
    // absolute against the plugin folder, so check what the mod asked for, not the prefix.
    for (const p of reads) expect(p).toMatch(/C:\\Users\\amy\\\.ownmind\\logs\\[\w-]+\.jsonl$/)
    expect(reads.some(p => p.endsWith('C:\\Users\\amy\\.ownmind\\logs\\compliance.jsonl'))).toBe(true)
    expect(runs[0]?.init?.cwd).toBe('C:\\Users\\amy\\.ownmind')
  })
}

// 2026-10-04: the auto-update failed four times on Vin's Mac, he fixed the install by hand,
// and every new window still toasted that the rules might be stale. The toast now needs the
// installed copy to really be behind, not just a failed attempt in today's log.
for (const [behind, tags, toasts] of [['current', '', 0], ['behind', 'v1.31.8\nv1.31.9\n', 1]] as const) {
  test(`update toast only when the install is ${behind}`, async ($, on) => {
    const o = on as any
    const v = (x: any) => () => ({ value: x })
    const shown: string[] = []
    o('session.start', () => ({ cwd: '/tmp' }))
    o('command.register', v({ command: 'x' }))
    o('ui.status', v(undefined))
    o('ui.toast', (_: any, e: any) => { shown.push(String(e.message ?? e.text ?? JSON.stringify(e))); return { value: undefined } })
    o('clock.every', v({}))
    o('clock.now', v(Date.parse('2026-10-04T12:00:00+08:00')))
    o('env.get', v('/home/test'))
    o('fs.read', (_: any, e: any) => {
      const p = String(e.path ?? '')
      if (p.endsWith('2026-10-04.jsonl')) return { value: `{"event":"update_failed","details":{"step":"pull"}}\n`.repeat(4) }
      return { deny: 'missing' }
    })
    o('process.run', v({ exitCode: 0, stdout: tags, stderr: '', isStdoutTruncated: false, isStderrTruncated: false }))
    o('session.messages', v([]))
    o('ui.open', v({ isPlaced: true }))
    await ($ as any).session.start({ source: 'startup', cwd: '/tmp' })
    // The /ownmind command awaits the refresh; session start only kicks it off.
    await ($ as any).command.run({ command: 'ownmind' })
    console.log(behind, 'toasts', JSON.stringify(shown))
    expect(shown.length).toBe(toasts)
    if (toasts) expect(shown[0]).toMatch(/落後 2 版/)
  })
}
