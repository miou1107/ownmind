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
  'git -c core.quotePath=false status --porcelain -uall': ' M src/a.ts\n M docs/README.md\n?? c.md\n',
  'git rev-parse --abbrev-ref @{u}': 'origin/main\n',
  'git rev-list --count @{u}..HEAD': '2\n',
  'git rev-list --left-right --count origin/main...main': '0\t0\n',
  'git stash list --format=%H': '',
  'git describe --tags --abbrev=0': 'rc0.35.124\n',
  'git rev-list --count rc0.35.124..HEAD': '2\n',
  'git merge-base main HEAD': 'abc\n',
  'git diff --name-only abc..HEAD': 'src/x.ts\nscripts/y.cjs\n',
  'git worktree list --porcelain': 'worktree /w/idaytour\n\n',
}
const CLEAN: Record<string, string> = {
  ...GIT,
  'git branch --no-merged main': '',
  'git -c core.quotePath=false status --porcelain -uall': '',
  'git rev-list --count @{u}..HEAD': '0\n',
  'git rev-list --count rc0.35.124..HEAD': '0\n',
  'git diff --name-only abc..HEAD': '',
}

type World = { containers: string; agents: any[]; files: Record<string, string>; ports?: string; tools?: any[]; procs?: string; cwds?: Record<string, string>; refs?: string; mtimes?: Record<string, number> }
const world = (): World => ({ containers: '', agents: [], files: {} })

// On Windows the engine hands the fs hooks `C:\w\idaytour\x` for the module's `/w/idaytour/x`;
// the fixtures are keyed the POSIX way, so look them up that way on every machine.
const posix = (p: string) => p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')

const setup = (on: any, git: Record<string, string>, w: World) => {
  on('clock.now', () => ({ value: T0 }))
  on('session.cwd', () => ({ value: CWD }))
  on('session.start', () => ({ cwd: CWD }))
  on('env.get', () => ({ value: '/home/v' }))
  // Unless a test says otherwise, every file was written after the session started.
  on('fs.stat', (_: any, e: any) => ({ value: { mtimeMs: w.mtimes?.[posix(e.path)] ?? T0 + 1 } }))
  on('fs.read', (_: any, e: any) => (posix(e.path) in w.files ? { value: w.files[posix(e.path)] } : { deny: 'missing' }))
  on('ui.toast', () => ({ value: undefined }))
  on('turn.complete', (_: any, e: any) => ({ text: e.answer }))
  on('command.register', () => ({ value: { command: 'wrapup' } }))
  on('tool.register', (_: any, e: any) => { w.tools = [...(w.tools ?? []), e]; return { value: { tool: `mcp__wrapup-check__${e.name}` } } })
  on('agent.list', () => ({ value: w.agents }))
  on('process.run', (_: any, e: any) => {
    const argv: string[] = e.argv ?? []
    let stdout = ''
    if (argv[0] === 'docker') stdout = w.containers
    else if (argv[0] === 'lsof' && argv.includes('cwd')) stdout = w.cwds?.[argv[argv.indexOf('-p') + 1]] ? `p1\nfcwd\nn${w.cwds[argv[argv.indexOf('-p') + 1]]}\n` : ''
    else if (argv[0] === 'lsof') stdout = `COMMAND PID USER FD TYPE DEVICE SIZE NODE NAME\n${w.ports ?? ''}`
    // The session runs as pid 500; pid 777 is a dev server one of its commands started.
    else if (argv[0] === 'sh' && argv[2] === 'echo $PPID') stdout = '500\n'
    else if (argv[1] === 'for-each-ref') stdout = w.refs ?? ''
    else if (argv[0] === 'ps') stdout = w.procs ?? '500 400 claude\n777 500 node\n'
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
  w.refs = 'main aaa\nvin/old-fix bbb\n'
  w.containers = 'abc123 idaytour-test-db /w/idaytour\n'
  await ($ as any).prompt.submit({ text: '好，收工', wait: false })
  expect(opened.length).toBe(1)
  expect(opened[0].title).toBe('OwnMind 收工自我檢查')
  const ctx = (seen.context ?? []).join('\n')
  expect(ctx).toMatch(/收工自檢 18:42/)
  expect(ctx).toMatch(/檔案有 3 個/)
  expect(ctx).toMatch(/idaytour-test-db/)
  expect(ctx).toMatch(/正式機有沒有上這一版/)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui: any = await mountPane($, surface)
    if (surface === 'terminal') {
      // While the AI is answering, the open items say it is handling them.
      expect(await ui.find({ type: 'Text', text: /收工檢查　完成 0 \/ 6/ })).toBeDefined()
      expect((await ui.find({ key: 'wrapup-row-0' }))?.props?.label).toBe('分支')
      expect(await ui.find({ type: 'Text', text: /AI 處理中/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /還沒處理/ })).toBeUndefined()
      // The detail opens on press and closes on the next press.
      expect(await ui.find({ type: 'Text', text: /改過、還沒 commit 的檔案有 3 個/ })).toBeUndefined()
      await ui.press({ key: 'wrapup-row-0' })
      expect(await ui.find({ type: 'Text', text: /改過、還沒 commit 的檔案有 3 個/ })).toBeDefined()
      await ui.press({ key: 'wrapup-row-0' })
      expect(await ui.find({ type: 'Text', text: /改過、還沒 commit 的檔案有 3 個/ })).toBeUndefined()
    } else {
      const svg = await ui.find({ type: 'Svg' })
      expect(svg?.props?.source).toMatch(/收工檢查/)
      expect(svg?.props?.source).toMatch(/完成 0 \/ 6/)
      expect(svg?.props?.source).toMatch(/>分支</)
      expect(svg?.props?.source).toMatch(/AI 處理中/)
      expect(svg?.props?.alt).toMatch(/分支：AI 處理中/)
      // The open items are listed underneath only once the AI is done.
      expect(await ui.find({ type: 'Text', text: /還沒打勾的項目/ })).toBeUndefined()
    }
    await ui.unmount()
  }

  // The AI's answer is complete: open items say who has to act, and their detail is listed.
  // A subagent finishing does not end it.
  await ($ as any).turn.complete({ answer: '查完了', durationMs: 1, isAborted: false, turnId: 't0', agentId: 'sub1', reason: 'answer' })
  const mid: any = await mountPane($, 'terminal')
  expect(await mid.find({ type: 'Text', text: /AI 處理中/ })).toBeDefined()
  await mid.unmount()
  await ($ as any).turn.complete({ answer: '好了', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  const term: any = await mountPane($, 'terminal')
  expect(await term.find({ type: 'Text', text: /AI 處理中/ })).toBeUndefined()
  expect(await term.find({ type: 'Text', text: /還沒處理：3 個檔沒 commit/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /還沒處理：1 個 container 還在跑/ })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /等你決定：/ })).toBeDefined()
  await term.unmount()
  const desk: any = await mountPane($, 'desktop')
  expect((await desk.find({ type: 'Svg' }))?.props?.source).toMatch(/還沒處理：3 個檔沒 commit/)
  expect(await desk.find({ type: 'Text', text: /還沒打勾的項目/ })).toBeDefined()
  await desk.unmount()
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
    // issue #169: describing the moment of wrapping up is not wrapping up
    '我收工時有哪些沒做',
    '收工的時候要檢查什麼',
    '收工前先把這個推上去',
    '收工後再處理',
    // 2026-10-08: a sentence that only mentions a wrap-up word is not a wrap-up
    '我的ownmind右側面板收工常會自己跳出',
    '好像是某些關鍵字很容易不小心誤觸發，可不可以真的在跑收工流程時才會觸發',
    '我要交接給 Amiee',
    'wrap-up time',
    '收工了嗎',
  ]) {
    await ($ as any).prompt.submit({ text, wait: false })
  }
  expect(opened.length).toBe(0)
  const wrapUps = ['收工', '今天先到這，下班', "let's wrap up", 'wrap up', '好，收工了', '收工囉', 'OK 收工！',
    '好了，收工', '那就收工吧', '我要收工了', '收工了，謝謝', '收工❤️', 'ＯＫ收工', 'wrap it up']
  for (const text of wrapUps) {
    await ($ as any).prompt.submit({ text, wait: false })
  }
  expect(opened.length).toBe(wrapUps.length)
  // A background task's notice that mentions a wrap-up is not the user wrapping up.
  await ($ as any).prompt.submit({ text: 'Agent "Review wrap-up resolve change" finished', wait: false, origin: { kind: 'task-notification' } })
  expect(opened.length).toBe(wrapUps.length)
})

test('a clean repo shows green tiles and no red mark', async ($, on) => {
  setup(on, CLEAN, world())
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/已乾淨/)
  const ui: any = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /完成 5 \/ 6/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /都併了，目錄乾淨/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /沒有殘留/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✗/ })).toBeUndefined()
  await ui.unmount()
})

test('commits waiting on the remote are not something this session left undone', async ($, on) => {
  setup(on, { ...CLEAN, 'git rev-list --left-right --count origin/main...main': '10\t0\n' }, world())
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).not.toMatch(/落後|沒拉/)
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

test('a yellow row the model handled turns green; a red row cannot be talked green; a new wrap-up starts over', async ($, on) => {
  const w = world()
  const git: Record<string, string> = { ...CLEAN, 'git branch --no-merged main': '  vin/old-fix\n', 'git rev-list --count rc0.35.124..HEAD': '2\n' }
  setup(on, git, w)
  let seen: any = null
  ;(on as any)('prompt.submit', (_: any, e: any) => { seen = e; return { text: e.text } })
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  w.refs = 'vin/old-fix bbb\n'
  await ($ as any).prompt.submit({ text: '收工', wait: false })
  // The model can only call what the session declared, with the six names to pick from.
  const decl = (w.tools ?? []).find((x: any) => x.name === 'resolve')
  expect(decl?.inputSchema?.properties?.item?.enum).toEqual(['分支', '推拉與 stash', '版號', '驗證與文件', '測試環境殘留', '待辦與交接'])
  const call = (item: string, done: string) => ($ as any).tool.call({ tool: 'mcp__wrapup-check__resolve', item, done })

  // Red: refused, and the tile stays red.
  const red = await call('分支', '不用管')
  expect(red.deny).toMatch(/還是紅色：這個 session 動過的分支還沒併進 main：vin\/old-fix/)

  // Yellow: green, with the model's sentence as the tile text.
  const ok = await call('版號', '只改了註解，排進下一次發版')
  expect(ok.result).toMatch(/「版號」已經變綠/)
  expect(ok.result).toMatch(/分支/)
  const ui: any = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /只改了註解，排進下一次發版/ })).toBeDefined()
  await ui.unmount()

  // The version row now says something else (one more commit): it is yellow again.
  git['git rev-list --count rc0.35.124..HEAD'] = '3\n'
  const again: any = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(again.text).toMatch(/待辦[\s\S]*版號：上一個 tag 是 rc0\.35\.124，之後還有 3 個 commit/)
  expect((await call('版號', '三個都只改註解')).result).toMatch(/「版號」已經變綠/)

  // An unknown item and an empty sentence are refused.
  expect((await call('部署', '好了')).deny).toMatch(/面板上沒有「部署」這一項/)
  expect((await call('待辦與交接', '  ')).deny).toMatch(/一句話/)

  // Fixing the red row makes it green; then the last yellow row, and all six are green.
  git['git branch --no-merged main'] = ''
  const last = await call('待辦與交接', '查過 OwnMind，沒有沒人接的交接單')
  expect(last.result).toMatch(/六項都是綠色/)

  // A new wrap-up forgets what was handled: the version row is yellow again.
  await ($ as any).prompt.submit({ text: '收工', wait: false })
  expect((seen.context ?? []).join('\n')).toMatch(/待辦\n[\s\S]*版號/)
  expect((seen.context ?? []).join('\n')).toMatch(/每一格都要處理到綠色/)
})

test('agy listening while it judges a reply is not residue', async ($, on) => {
  const w = world()
  setup(on, CLEAN, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  w.ports = 'agy 22088 v 7u IPv4 0x1 0t0 TCP 127.0.0.1:57259 (LISTEN)\nnode 777 v 7u IPv4 0x1 0t0 TCP 127.0.0.1:5173 (LISTEN)\n'
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/port 還開著：node 127\.0\.0\.1:5173/)
  expect(r.text).not.toMatch(/agy/)
})

test('a wrap-up typed during a running turn waits for its own answer; a blocked one does not stay busy', async ($, on) => {
  const w = world()
  setup(on, GIT, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  let block = false
  ;(on as any)('prompt.submit', (_: any, e: any) => (block ? { drop: 'blocked' } : { text: e.text }))
  await start($)
  // Typed over turn t9: t9 ending is not the answer to the wrap-up.
  await ($ as any).prompt.submit({ text: '收工', wait: false, turnId: 't9' })
  await ($ as any).turn.complete({ answer: 'earlier work', durationMs: 1, isAborted: false, turnId: 't9', reason: 'answer' })
  let ui: any = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /AI 處理中/ })).toBeDefined()
  await ui.unmount()
  await ($ as any).turn.complete({ answer: '好了', durationMs: 1, isAborted: false, turnId: 't10', reason: 'answer' })
  ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /AI 處理中/ })).toBeUndefined()
  await ui.unmount()
  // Blocked beneath: no turn will run, so the items say who acts right away.
  block = true
  await ($ as any).prompt.submit({ text: '收工', wait: false })
  ui = await mountPane($, 'terminal')
  expect(await ui.find({ type: 'Text', text: /AI 處理中/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /還沒處理：3 個檔沒 commit/ })).toBeDefined()
  await ui.unmount()
})

test('the header says the wrap-up is in progress until the AI answers, then the time it finished', async ($, on) => {
  const w = world()
  setup(on, CLEAN, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await start($)
  let ui: any = await mountPane($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /還沒查過/ })).toBeDefined()
  await ui.unmount()
  await ($ as any).prompt.submit({ text: '收工', wait: false })
  for (const surface of ['terminal', 'desktop'] as const) {
    ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^收工狀態：進行中$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /查的/ })).toBeUndefined()
    await ui.unmount()
  }
  await ($ as any).turn.complete({ answer: '好了', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    ui = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /^收工狀態：18:42 完成$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /進行中/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('once the wrap-up is done and all six are green, the bottom says the session can be closed', async ($, on) => {
  const w = world()
  setup(on, CLEAN, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await start($)
  await ($ as any).prompt.submit({ text: '收工', wait: false })
  const passed = async (surface: 'terminal' | 'desktop') => {
    const ui: any = await mountPane($, surface)
    const hit = surface === 'desktop'
      ? /成功通過所有收工檢查，可安心關閉此對話/.test((await ui.find({ type: 'Svg' }))?.props?.source ?? '')
      : await ui.find({ type: 'Text', text: /成功通過所有收工檢查，可安心關閉此對話/ })
    await ui.unmount()
    return !!hit
  }
  // The handoff row is still yellow: no banner, even after the AI answers.
  await ($ as any).tool.call({ tool: 'mcp__wrapup-check__resolve', item: '待辦與交接', done: '查過 OwnMind，沒有沒人接的交接單' })
  // All green but the AI is still working: no banner yet.
  expect(await passed('terminal')).toBe(false)
  expect(await passed('desktop')).toBe(false)
  await ($ as any).turn.complete({ answer: '好了', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await passed('terminal')).toBe(true)
  expect(await passed('desktop')).toBe(true)
})

test('a wrap-up that ends with a yellow item left shows no closing banner', async ($, on) => {
  const w = world()
  setup(on, CLEAN, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  await start($)
  await ($ as any).prompt.submit({ text: '收工', wait: false })
  await ($ as any).turn.complete({ answer: '好了', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui: any = await mountPane($, surface)
    expect(await ui.find({ type: 'Text', text: /可安心關閉此對話/ })).toBeUndefined()
    if (surface === 'desktop') expect(((await ui.find({ type: 'Svg' }))?.props?.source ?? '')).not.toMatch(/可安心關閉此對話/)
    await ui.unmount()
  }
})

test('a port another window opened is not this session\'s residue; one left in the background from this folder is', async ($, on) => {
  const w = world()
  setup(on, CLEAN, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  w.procs = '500 400 claude\n900 400 claude\n901 900 node\n910 1 node\n920 1 node\n'
  w.cwds = { '910': CWD, '920': '/elsewhere/idaytour' }
  w.ports = [
    'claude 900 v 7u IPv4 0x1 0t0 TCP 127.0.0.1:61340 (LISTEN)',
    'node 901 v 7u IPv4 0x1 0t0 TCP 127.0.0.1:5198 (LISTEN)',
    'node 910 v 7u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)',
    'node 920 v 7u IPv4 0x1 0t0 TCP 127.0.0.1:4000 (LISTEN)',
  ].join('\n') + '\n'
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/port 還開著：node 127\.0\.0\.1:3000/)
  expect(r.text).not.toMatch(/61340|5198|4000/)
})

test('branches, stash entries and files another window left before the session started are not this session\'s', async ($, on) => {
  const w = world()
  const git: Record<string, string> = {
    ...CLEAN, 'git rev-parse HEAD': 'h1\n', 'git rev-parse --verify --quiet h1^{commit}': 'h1\n',
    'git branch --no-merged main': '  other/work\n  vin/new\n', 'git stash list --format=%H': 's1\n',
    'git -c core.quotePath=false status --porcelain -uall': ' M old.ts\n',
  }
  setup(on, git, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  w.refs = 'main aaa\nother/work ccc\n'
  w.mtimes = { [`${CWD}/old.ts`]: T0 - 1000 }
  await start($)
  w.refs = 'main aaa\nother/work ccc\nvin/new ddd\n'
  git['git stash list --format=%H'] = 's2\ns1\n'
  git['git -c core.quotePath=false status --porcelain -uall'] = ' M old.ts\n M new.ts\n'
  git['git rev-list --count @{u}..HEAD ^h1'] = '0\n'
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/動過的分支還沒併進 main：vin\/new/)
  expect(r.text).not.toMatch(/other\/work/)
  expect(r.text).toMatch(/還沒 commit 的檔案有 1 個/)
  expect(r.text).toMatch(/存進 stash 的改動有 1 份/)
})

test('the version row is skipped only when the session made no commit anywhere and left the version files alone', async ($, on) => {
  const w = world()
  w.files[`${CWD}/package.json`] = '{ "version": "0.35.125" }'
  const git: Record<string, string> = { ...CLEAN, 'git rev-parse HEAD': 'h1\n', 'git rev-parse --verify --quiet h1^{commit}': 'h1\n' }
  setup(on, git, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  await start($)
  const run = async () => (await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })).text
  expect(await run()).toMatch(/這個 session 沒有新的 commit，版號不用動/)
  git['git -c core.quotePath=false status --porcelain -uall'] = ' M package.json\n'
  expect(await run()).toMatch(/package\.json 0\.35\.125 跟 tag rc0\.35\.124 對不上/)
})

test('a changed file whose name git quotes, or that sits in a new folder, is found', async ($, on) => {
  const w = world()
  const git: Record<string, string> = { ...CLEAN, 'git -c core.quotePath=false status --porcelain -uall': ' M "a b.ts"\n?? 說明/新的.ts\n' }
  setup(on, git, w)
  ;(on as any)('ui.open', () => ({ value: { isPlaced: true } }))
  ;(on as any)('command.run', () => ({ text: '' }))
  w.mtimes = { [`${CWD}/a b.ts`]: T0 - 1000 }
  await start($)
  w.mtimes = {}
  const r = await ($ as any).command.run({ command: 'wrapup', args: '', origin: { kind: 'composer' } })
  expect(r.text).toMatch(/還沒 commit 的檔案有 2 個/)
  expect(r.text).toMatch(/改了 2 個程式檔/)
})
