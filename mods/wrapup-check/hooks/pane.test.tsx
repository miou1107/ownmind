import { test, expect } from 'claude-code/testing'

const T0 = Date.parse('2026-10-03T18:42:00+08:00')
const CWD = '/w/idaytour'

// A checkout with things to clean up: three files not committed (one of them an unstaged
// README), two commits not pushed, commits after the newest tag, and a container that appeared
// after the session started.
const GIT: Record<string, string> = {
  'git rev-parse --is-inside-work-tree': 'true\n',
  'git symbolic-ref --short refs/remotes/origin/HEAD': 'origin/main\n',
  'git branch --show-current': 'main\n',
  'git branch --no-merged main': '  vin/old-fix\n',
  'git status --porcelain': ' M src/a.ts\n M docs/README.md\n?? c.md\n',
  'git rev-list --left-right --count @{u}...HEAD': '0\t2\n',
  'git rev-list --left-right --count origin/main...main': '0\t0\n',
  'git stash list': '',
  'git describe --tags --abbrev=0': 'rc0.35.124\n',
  'git rev-list --count rc0.35.124..HEAD': '2\n',
  'git merge-base main HEAD': 'abc\n',
  'git diff --name-only abc..HEAD': 'src/x.ts\nscripts/y.cjs\n',
  'git worktree list --porcelain': 'worktree /w/idaytour\n\n',
}
const CLEAN: Record<string, string> = {
  ...GIT,
  'git branch --no-merged main': '',
  'git status --porcelain': '',
  'git rev-list --left-right --count @{u}...HEAD': '0\t0\n',
  'git rev-list --count rc0.35.124..HEAD': '0\n',
  'git diff --name-only abc..HEAD': '',
}

type World = { containers: string; agents: any[]; files: Record<string, string> }
const world = (): World => ({ containers: '', agents: [], files: {} })

const setup = (on: any, git: Record<string, string>, w: World) => {
  on('clock.now', () => ({ value: T0 }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.start', () => ({ cwd: CWD }))
  on('env.get', () => ({ value: '/home/v' }))
  on('fs.read', (_: any, e: any) => (e.path in w.files ? { value: w.files[e.path] } : { deny: 'missing' }))
  on('ui.toast', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'wrapup' } }))
  on('agent.list', () => ({ value: w.agents }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv ?? []
    let stdout = ''
    if (argv[0] === 'docker') stdout = w.containers
    else if (argv[0] === 'lsof') stdout = 'COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n'
    else stdout = git[argv.join(' ')] ?? ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const mountPane = ($: any, surface: 'terminal' | 'desktop') =>
  $.ui.mount({
    plugin: 'wrapup-check', surface, component: 'Pane', requestId: 'wrapup-check',
    props: { title: 'OwnMind 收工自我檢查', isFocused: false, bodyColumns: 70, placement: 'dock' },
  })

const start = async ($: any) => {
  await ($ as any).session.start({ source: 'startup', cwd: CWD, surface: 'desktop', isInteractive: true })
}

test('typing 收工 runs the six checks, opens the pane and hands the model the summary', async ($, on) => {
  const w = world()
  setup(on, GIT, w)
  const opened: any[] = []
  ;(on as any)('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  let seen: any = null
  ;(on as any)('prompt.submit', (_: any, e: any) => { seen = e; return { text: e.text } })
  await start($)
  w.containers = 'abc123 idaytour-test-db /w/idaytour\n'
  await ($ as any).prompt.submit({ text: '好，收工', wait: false })
  expect(opened.length).toBe(1)
  expect(opened[0].title).toBe('OwnMind 收工自我檢查')
  const ctx = (seen.context ?? []).join('\n')
  expect(ctx).toMatch(/收工自檢 18:42/)
  expect(ctx).toMatch(/3 個檔/)
  expect(ctx).toMatch(/idaytour-test-db/)
  expect(ctx).toMatch(/正式機有沒有上這一版/)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui: any = await mountPane($, surface)
    if (surface === 'terminal') {
      // The terminal draws the summary as text; the desktop puts it in the picture's alt text.
      expect(await ui.find({ type: 'Text', text: /項乾淨/ })).toBeDefined()
      expect((await ui.find({ key: 'wrapup-row-0' }))?.props?.label).toBe('分支')
      expect(await ui.find({ type: 'Text', text: /3 個檔沒 commit/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /2 個 commit 沒推/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1 個 container 還在跑/ })).toBeDefined()
      // The detail opens on press and closes on the next press.
      expect(await ui.find({ type: 'Text', text: /還沒 commit 的改動：3 個檔/ })).toBeUndefined()
      await ui.press({ key: 'wrapup-row-0' })
      expect(await ui.find({ type: 'Text', text: /還沒 commit 的改動：3 個檔/ })).toBeDefined()
      await ui.press({ key: 'wrapup-row-0' })
      expect(await ui.find({ type: 'Text', text: /還沒 commit 的改動：3 個檔/ })).toBeUndefined()
    } else {
      const svg = await ui.find({ type: 'Svg' })
      expect(svg).toBeDefined()
      expect(svg?.props?.source).toMatch(/✗ 分支/)
      expect(svg?.props?.source).toMatch(/？ 版號/)
      expect(svg?.props?.alt).toMatch(/項乾淨/)
      expect(svg?.props?.alt).toMatch(/分支：3 個檔沒 commit/)
      expect(await ui.find({ type: 'Text', text: /待處理事項/ })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('an unstaged README counts as a doc change, and .cjs / .ps1 count as code (issue #158)', async ($, on) => {
  const w = world()
  setup(on, { ...GIT, 'git diff --name-only abc..HEAD': 'install.ps1\nscripts/x.cjs\n' }, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/改了 3 個程式檔/)
  expect(r.text).toMatch(/文件有跟著動：docs\/README\.md/)
  expect(r.text).not.toMatch(/(^|[^d])ocs\/README/)
})

test('words that only look like a wrap-up do not trigger it', async ($, on) => {
  setup(on, GIT, world())
  const opened: any[] = []
  ;(on as any)('ui.open', (_: any, e: any) => { opened.push(e); return { value: { isPlaced: true } } })
  ;(on as any)('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  for (const text of [
    '幫我看一下這張單',
    '幫我寫一份交接文件給 Amiee',
    '明天下班前要交',
    '這段文案幫我收尾一下',
    'claude plugin test mods/wrapup-check',
    'review the wrapup-check mod',
    '/wrapup',
  ]) {
    await ($ as any).prompt.submit({ text, wait: false })
  }
  expect(opened.length).toBe(0)
  for (const text of ['收工', '今天先到這，下班', '我要交接給 Amiee', "let's wrap up", 'wrap-up time']) {
    await ($ as any).prompt.submit({ text, wait: false })
  }
  expect(opened.length).toBe(5)
})

test('a clean repo shows green tiles and no red mark', async ($, on) => {
  setup(on, CLEAN, world())
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/已乾淨/)
  const ui: any = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /5 項乾淨/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /都併了，目錄乾淨/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /沒有殘留/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✗/ })).toBeUndefined()
  await ui.unmount()
})

test('a local main that fell behind origin/main is reported even when the current branch is in sync', async ($, on) => {
  setup(on, { ...CLEAN, 'git rev-list --left-right --count origin/main...main': '10\t0\n' }, world())
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/本機的 main 落後 origin\/main 10 個 commit/)
})

test('an rc tag that matches package.json is not a mismatch', async ($, on) => {
  const w = world()
  w.files[`${CWD}/package.json`] = '{ "version": "0.35.124" }'
  setup(on, CLEAN, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).not.toMatch(/對不上/)
  expect(r.text).toMatch(/tag rc0\.35\.124 就是現在這一版/)
})

test('outside a git checkout the four git rows say so instead of showing green', async ($, on) => {
  setup(on, {}, world())
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).not.toMatch(/都併進/)
  expect((r.text.match(/這個資料夾不是 git 專案/g) ?? []).length).toBe(4)
})

test('a container of another project (compose working dir elsewhere) is not residue; a failed subagent is not owed', async ($, on) => {
  const w = world()
  setup(on, CLEAN, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  w.containers = 'ima001 ima-db-1 /w/ima\nown002 idaytour-db /w/idaytour\n'
  w.agents = [{ id: 'a1', description: 'crashed one', type: 'Explore', status: 'failed' }, { id: 'a2', description: 'still going', type: 'Explore', status: 'running' }]
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/container 還在跑：idaytour-db/)
  expect(r.text).not.toMatch(/ima-db-1/)
  expect(r.text).toMatch(/交辦出去還沒回來的：still going/)
  expect(r.text).not.toMatch(/crashed one/)
})

test('test commands and background commands run in this session are counted', async ($, on) => {
  setup(on, GIT, world())
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  ;(on as any)('tool.call', () => ({ result: {}, text: 'ok' }))
  await start($)
  await ($ as any).tool.call({ tool: 'Bash', command: 'npm test' })
  await ($ as any).tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true })
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/跑過 1 次測試指令/)
  expect(r.text).toMatch(/丟到背景跑的指令有 1 條/)
})
