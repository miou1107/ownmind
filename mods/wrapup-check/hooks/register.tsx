import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { WrapupBaseline, WrapupReport, WrapupResolution, WrapupRow } from '../types'

// Wrap-up self-check. When the user says they are wrapping up (收工, 收尾, 下班, 交接, wrap up),
// run the six checks of team standard 723, open the result in a pane, and hand the same
// result to the model so its answer is grounded in what was actually found.
//
// The user-facing strings are Traditional Chinese on purpose: the team standard they
// mirror is written in it, and the AI answers the user in it (see configs/CLAUDE.md).

const PANE = 'wrapup-check'
const TITLE = 'OwnMind 收工自我檢查'
// 收工 always counts. The other words also appear inside ordinary sentences (交接文件, 下班前,
// 收尾一下) and are only taken when they stand on their own. The English form must not be
// part of a longer token, so the mod's own name (wrapup-check) and /wrapup do not count.
const TRIGGER = /收工|收尾(?!一下|工作|的)|下班(?!前|後|時間|之後|以後)|交接(?!文件|單|人|事項|書|清單|流程)|(?<![\w\/-])wrap[\s-]?up(?![\w-])/i
const NOT_THE_USER = new Set(['task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'coordinator', 'observer', 'observer-activity'])
const TEST_CMD = /\b(pytest|vitest|jest|mocha|go test|cargo test|npm test|pnpm test|yarn test|bun test|plugin test|make test)\b/
const MAIN_CANDIDATES = ['main', 'master']
const CODE_FILE = /\.(ts|tsx|cts|mts|js|jsx|cjs|mjs|py|go|rs|vue|svelte|sql|sh|ps1|psm1|vbs|bat|cmd)$/
// Listening ports that belong to the OS or to always-on desktop apps, never to a session.
// agy is OwnMind's own reply judge on machines that pick it: every turn starts one, it listens
// while it judges and exits by itself, so a wrap-up taken mid-judge would always see it.
const PORT_NOISE = /^(ControlCe|rapportd|com\.docke|Docker|ollama|Google|Chrome|Safari|Dropbox|Nextcloud|OneDrive|Spotify|Slack|zoom|agy\s)/i

const EMPTY_BASELINE: WrapupBaseline = { containers: [], ports: [], worktrees: [], takenAt: 0 }
const EMPTY_REPORT: WrapupReport = { at: 0, rows: [] }

const baseline = atom({ plugin: 'wrapup-check', key: 'baseline' } as const, EMPTY_BASELINE)
const report = atom({ plugin: 'wrapup-check', key: 'report' } as const, EMPTY_REPORT)
const counts = atom({ plugin: 'wrapup-check', key: 'counts' } as const, { tests: 0, background: 0 })
const openRows = atom({ plugin: 'wrapup-check', key: 'openRows' } as const, [])
const resolved = atom({ plugin: 'wrapup-check', key: 'resolved' } as const, [] as WrapupResolution[])
const RESOLVE_TOOL = 'mcp__wrapup-check__resolve'

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
const lines = (s: string) => s.split('\n').map(l => l.trim()).filter(Boolean)
// Paths out of `git status --porcelain`. The two status columns are followed by one space, and
// the first column is a space for an unstaged change, so the lines must not be trimmed first
// (that cut the first letter off `docs/README.md`, issue #158). A rename shows `old -> new`.
const porcelainPaths = (stdout: string) =>
  stdout.split('\n').filter(l => l.length > 3).map(l => l.slice(3).trim()).map(l => l.includes(' -> ') ? l.split(' -> ').pop()! : l)

// Run one command; a failure, a missing binary or a timeout all read as "no output".
const sh = async ($: any, argv: string[], cwd?: string) => {
  try {
    const r = await $.process.run(argv, { cwd, timeoutMs: 15000 })
    return r.exitCode === 0 ? String(r.stdout ?? '') : ''
  } catch { return '' }
}

// Read a file; a missing one reads as empty. Works on every platform, unlike `sh -c`.
const readFile = async ($: any, path: string) => {
  try { return String(await $.fs.read(path)) } catch { return '' }
}

const dockerIds = async ($: any) => lines(await sh($, ['docker', 'ps', '--format', '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project.working_dir"}}']))
// A container another project started with docker compose is not this session's residue.
const isOurs = (c: string, cwd: string) => {
  const dir = c.split(' ').slice(2).join(' ')
  const under = (a: string, b: string) => a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`)
  return !dir || under(dir, cwd) || under(cwd, dir)
}
// macOS / Linux only (lsof); on Windows the list is empty and the port check is skipped.
const listenPorts = async ($: any) =>
  lines(await sh($, ['lsof', '-nP', '-iTCP', '-sTCP:LISTEN']))
    .slice(1)
    .map(l => { const c = l.split(/\s+/); return `${c[0]} ${c[8] ?? ''}` })
    .filter(p => !PORT_NOISE.test(p))
const worktrees = async ($: any, cwd: string) =>
  lines(await sh($, ['git', 'worktree', 'list', '--porcelain'], cwd)).filter(l => l.startsWith('worktree ')).map(l => l.slice(9))

// What the machine looks like when the session starts. The residue check compares against it,
// so only what this session added counts.
const snapshot = async ($: any) => {
  const cwd = await $.session.cwd()
  const [containers, ports, trees] = await Promise.all([dockerIds($), listenPorts($), worktrees($, cwd)])
  const takenAt = await $.clock.now()
  await update($, baseline, () => ({ containers, ports, worktrees: trees, takenAt }))
}

const mainBranch = async ($: any, cwd: string) => {
  const head = await sh($, ['git', 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd)
  if (head.trim()) return head.trim().replace(/^origin\//, '')
  for (const c of MAIN_CANDIDATES) {
    if ((await sh($, ['git', 'rev-parse', '--verify', '--quiet', c], cwd)).trim()) return c
  }
  return 'main'
}

// 1. Branches: anything not merged into main, and an unclean working tree.
const checkBranches = async ($: any, cwd: string): Promise<WrapupRow> => {
  const name = '分支'
  const main = await mainBranch($, cwd)
  const current = (await sh($, ['git', 'branch', '--show-current'], cwd)).trim()
  const unmerged = lines(await sh($, ['git', 'branch', '--no-merged', main], cwd)).map(b => b.replace(/^[*+]?\s*/, '')).filter(b => b && b !== main)
  const dirty = lines(await sh($, ['git', 'status', '--porcelain'], cwd))
  const out: string[] = []
  if (current && current !== main) out.push(`現在在 ${current}，不在 ${main}`)
  if (unmerged.length) out.push(`還沒併進 ${main} 的分支：${unmerged.slice(0, 6).join('、')}${unmerged.length > 6 ? ` 等 ${unmerged.length} 條` : ''}`)
  if (dirty.length) out.push(`還沒 commit 的改動：${dirty.length} 個檔`)
  const short = dirty.length ? `${dirty.length} 個檔沒 commit` : unmerged.length ? `${unmerged.length} 條分支沒併` : current && current !== main ? `還在 ${current}` : '都併了，目錄乾淨'
  return { name, short, state: out.length ? 'dirty' : 'clean', lines: out.length ? out : [`都併進 ${main} 了，工作目錄乾淨`] }
}

// 2. Push / pull / stash: commits not pushed, commits not pulled, stash entries.
const checkSync = async ($: any, cwd: string): Promise<WrapupRow> => {
  const name = '推拉與 stash'
  const out: string[] = []
  const lr = (await sh($, ['git', 'rev-list', '--left-right', '--count', '@{u}...HEAD'], cwd)).trim()
  if (lr) {
    const [behind, ahead] = lr.split(/\s+/).map(Number)
    if (ahead > 0) out.push(`有 ${ahead} 個 commit 還沒推上去`)
    if (behind > 0) out.push(`遠端有 ${behind} 個 commit 還沒拉下來`)
  } else {
    out.push('這條分支沒有對應的遠端分支，推不推要你決定')
  }
  // The local main can fall behind origin/main while another branch is checked out; a session
  // that then branches off it starts from stale code (issue #158).
  const main = await mainBranch($, cwd)
  const mainLr = (await sh($, ['git', 'rev-list', '--left-right', '--count', `origin/${main}...${main}`], cwd)).trim()
  const mainBehind = mainLr ? Number(mainLr.split(/\s+/)[0]) : 0
  if (mainBehind > 0) out.push(`本機的 ${main} 落後 origin/${main} ${mainBehind} 個 commit，開新分支前要先拉`)
  const stash = lines(await sh($, ['git', 'stash', 'list'], cwd))
  if (stash.length) out.push(`stash 裡還躺著 ${stash.length} 份改動`)
  const isDirty = out.length > 0
  const onlyNoUpstream = !lr && out.length === 1
  const short = out.find(l => /沒推/.test(l)) ? out.find(l => /沒推/.test(l))!.replace(/還沒推上去/, '沒推') : !lr ? '沒有遠端分支' : mainBehind > 0 ? `${main} 落後 ${mainBehind} 個 commit` : stash.length ? `stash 有 ${stash.length} 份` : out.length ? '有東西沒拉' : '都對齊了'
  return { name, short, state: isDirty ? (onlyNoUpstream ? 'judge' : 'dirty') : 'clean', lines: isDirty ? out : ['推拉都對齊了，stash 是空的'] }
}

// 3. Version and deploy: the version files against the newest tag, and commits since it.
const checkVersion = async ($: any, cwd: string): Promise<WrapupRow> => {
  const name = '版號'
  const tag = (await sh($, ['git', 'describe', '--tags', '--abbrev=0'], cwd)).trim()
  const versions: string[] = []
  const pkgText = await readFile($, `${cwd}/package.json`)
  if (pkgText) { try { const v = JSON.parse(pkgText).version; if (v) versions.push(`package.json ${v}`) } catch { /* not JSON */ } }
  const pyText = await readFile($, `${cwd}/pyproject.toml`)
  const py = /^version\s*=\s*"?([^"\n]+)"?/m.exec(pyText)
  if (py) versions.push(`pyproject.toml ${py[1].trim()}`)
  const vf = (await readFile($, `${cwd}/VERSION`)).split('\n')[0].trim()
  if (vf) versions.push(`VERSION ${vf}`)
  if (!tag && versions.length === 0) return { name, short: '沒有版號，略過', state: 'clean', lines: ['這個 repo 沒有版號也沒有 tag，不用對'] }
  const out: string[] = []
  if (tag) {
    const since = Number((await sh($, ['git', 'rev-list', '--count', `${tag}..HEAD`], cwd)).trim() || 0)
    out.push(since > 0 ? `上一個 tag 是 ${tag}，之後還有 ${since} 個 commit 沒打 tag、沒部署` : `tag ${tag} 就是現在這一版`)
    const tagNum = tag.replace(/^[^0-9]*/, '')
    for (const v of versions) {
      const num = v.split(' ')[1]
      if (num && num !== tagNum && !tagNum.startsWith(num)) out.push(`${v} 跟 tag ${tag} 對不上`)
    }
  } else {
    out.push(`檔案裡有版號（${versions.join('、')}）但 git 沒有任何 tag`)
  }
  const isJudge = out.some(l => /沒打 tag|對不上|沒有任何 tag/.test(l))
  // This row only compares files with tags; whether the server runs this version is not known here.
  out.push('正式機有沒有上這一版，要另外查')
  const short = out.find(l => /對不上/.test(l)) ? '版號跟 tag 對不上' : out.find(l => /沒打 tag/.test(l)) ? out.find(l => /沒打 tag/.test(l))!.replace(/^.*之後還有 /, '').replace(/、沒部署$/, '') : !tag ? '有版號但沒 tag' : `tag 就是這版`
  return { name, short, state: isJudge ? 'judge' : 'clean', lines: out }
}

// 4. Verification and docs: did this session run a test command, did the docs move with the code.
const checkDocs = async ($: any, cwd: string, tests: number): Promise<WrapupRow> => {
  const name = '驗證與文件'
  const main = await mainBranch($, cwd)
  const base = (await sh($, ['git', 'merge-base', main, 'HEAD'], cwd)).trim()
  const changed = base ? lines(await sh($, ['git', 'diff', '--name-only', `${base}..HEAD`], cwd)) : []
  const dirty = porcelainPaths(await sh($, ['git', 'status', '--porcelain'], cwd))
  const all = Array.from(new Set([...changed, ...dirty]))
  const code = all.filter(f => CODE_FILE.test(f) && !/\.(test|spec)\./.test(f))
  const docs = all.filter(f => /CHANGELOG|README|docs\/|openspec\//i.test(f))
  const out: string[] = []
  if (code.length === 0) return { name, short: '沒改程式', state: 'clean', lines: ['這一輪沒改程式，不用補驗證'] }
  out.push(tests > 0 ? `這個 session 跑過 ${tests} 次測試指令` : `改了 ${code.length} 個程式檔，這個 session 沒跑過測試`)
  out.push(docs.length > 0 ? `文件有跟著動：${docs.slice(0, 4).join('、')}` : 'CHANGELOG、README、docs 都沒動，要不要補你看一下')
  const state = tests > 0 && docs.length > 0 ? 'clean' : tests === 0 ? 'dirty' : 'judge'
  const short = tests === 0 ? '沒跑過測試' : docs.length === 0 ? '文件沒跟著動' : '測試跑過、文件有動'
  return { name, short, state, lines: out }
}

// 5. Residue: containers, ports, worktrees and subagents that appeared since the session started.
const checkResidue = async ($: any, cwd: string, background: number): Promise<WrapupRow> => {
  const name = '測試環境殘留'
  const b = await read($, baseline)
  if (!b.takenAt) return { name, short: '基準還沒拍好', state: 'judge', lines: ['session 剛開始，還沒記下原本有哪些 container、port、worktree，這一項這次比不了'] }
  const out: string[] = []
  const nowContainers = await dockerIds($)
  const newContainers = nowContainers.filter(c => !b.containers.includes(c) && isOurs(c, cwd))
  if (newContainers.length) out.push(`這個 session 起的 container 還在跑：${newContainers.map(c => c.split(' ')[1] ?? c).join('、')}`)
  const nowPorts = await listenPorts($)
  const newPorts = nowPorts.filter(p => !b.ports.includes(p))
  if (newPorts.length) out.push(`這個 session 開的 port 還開著：${newPorts.join('、')}`)
  const nowTrees = await worktrees($, cwd)
  const newTrees = nowTrees.filter(w => !b.worktrees.includes(w))
  if (newTrees.length) out.push(`這個 session 建的 worktree 還在：${newTrees.map(w => w.split('/').pop()).join('、')}`)
  if (background > 0) out.push(`這個 session 丟到背景跑的指令有 ${background} 條，有沒有停掉要你看一下`)
  // A container or worktree that appeared is this session's to clean; a new port may belong to
  // any app that started meanwhile, so it is only something to look at.
  const state = out.length === 0 ? 'clean' : (newContainers.length || newTrees.length) ? 'dirty' : 'judge'
  const short = newContainers.length ? `${newContainers.length} 個 container 還在跑` : newTrees.length ? `${newTrees.length} 個 worktree 還在` : newPorts.length ? `${newPorts.length} 個 port 還開著` : background > 0 ? `${background} 條背景指令要看` : '沒有殘留'
  return { name, short, state, lines: out.length ? out : ['跟 session 開始的時候比，沒有多出 container、port、worktree，也沒有 subagent 在跑'] }
}

// 6. Todo and handoff: subagents that have not reported back. The OwnMind handoff list is
// not reachable from here, so the model is told to query it (see the prompt context below).
const checkHandoff = async ($: any): Promise<WrapupRow> => {
  const name = '待辦與交接'
  const out: string[] = []
  let pending: string[] = []
  // AgentInfo.status is running | completed | failed | killed; only a running one is still owed.
  try { pending = (await $.agent.list()).filter((a: any) => /^running$/i.test(String(a.status))).map((a: any) => a.name ?? a.description ?? a.id) } catch { /* no subagents */ }
  if (pending.length) out.push(`交辦出去還沒回來的：${pending.slice(0, 4).join('、')}`)
  out.push('OwnMind 裡有沒有沒人接手的交接單，我會另外查一次再告訴你')
  const short = pending.length ? `${pending.length} 件還沒回來` : '交接單要查 OwnMind'
  return { name, short, state: pending.length ? 'dirty' : 'judge', lines: out }
}

const NAMES = ['分支', '推拉與 stash', '版號', '驗證與文件', '測試環境殘留', '待辦與交接']

// Outside a git checkout (or without git on PATH) the four git rows cannot be answered, and a
// green mark there would be the false green the proposal rules out.
const notGitRow = (name: string): WrapupRow =>
  ({ name, short: '這裡不是 git 專案', state: 'judge', lines: ['這個資料夾不是 git 專案，或是這台電腦沒有 git，這一項查不了'] })

// Each run gets a number; a run that finishes after a newer one started does not write, so a
// slow run can never put an older result (or its 查中 rows) over a newer one.
let runSeq = 0

const runChecks = async ($: any) => {
  const seq = ++runSeq
  const cwd = await $.session.cwd()
  const c = await read($, counts)
  const running: WrapupRow[] = NAMES.map(name => ({ name, short: '查中', state: 'running', lines: ['查中'] }))
  const started = await $.clock.now()
  await update($, report, () => ({ at: started, rows: running }))
  const isGit = (await sh($, ['git', 'rev-parse', '--is-inside-work-tree'], cwd)).trim() === 'true'
  const rows = await Promise.all([
    isGit ? checkBranches($, cwd) : notGitRow(NAMES[0]),
    isGit ? checkSync($, cwd) : notGitRow(NAMES[1]),
    isGit ? checkVersion($, cwd) : notGitRow(NAMES[2]),
    isGit ? checkDocs($, cwd, c.tests) : notGitRow(NAMES[3]),
    checkResidue($, cwd, c.background),
    checkHandoff($),
  ])
  // A yellow row the model already handled turns green. A red row stays red whatever the
  // model said: red is a fact the mod measured, and only fixing it makes it go away.
  const done = await read($, resolved)
  for (let i = 0; i < rows.length; i++) {
    // Only while the row still says what it said when it was handled: a new reason is new work.
    const r = done.find(d => d.name === rows[i].name && d.seen === rows[i].lines.join('\n'))
    if (r && rows[i].state === 'judge') rows[i] = { name: rows[i].name, short: r.done, state: 'clean', lines: [r.done] }
  }
  const at = await $.clock.now()
  if (seq === runSeq) await update($, report, () => ({ at, rows }))
  return { rows, at }
}

const MARK: Record<WrapupRow['state'], string> = { clean: '✓', dirty: '✗', judge: '？', running: '…' }

// The text form, for the model and for the /wrapup command: "clean" and "todo", as the
// team standard asks the report to be split.
const summary = (rows: WrapupRow[], at: number) => {
  const clean = rows.filter(r => r.state === 'clean')
  const todo = rows.filter(r => r.state !== 'clean')
  const block = (title: string, rs: WrapupRow[]) =>
    rs.length ? `${title}\n${rs.map(r => `- ${r.name}：${r.lines.join('；')}`).join('\n')}` : `${title}\n- 無`
  return `[收工自檢 ${clock(at)}]\n${block('已乾淨', clean)}\n${block('待辦', todo)}`
}

// Desktop draws no Box borders, so the cards and tiles are drawn as one SVG. The terminal
// has no Svg element and gets one row per check instead.
const HEX: Record<WrapupRow['state'], string> = { clean: '#2e9e5b', dirty: '#d64545', judge: '#d9a400', running: '#888888' }
const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const W = 600

const kpiSvg = (nClean: number, nDirty: number, nJudge: number) => {
  const cards: Array<[number, string, string]> = [[nClean, '乾淨', HEX.clean], [nDirty, '待處理', HEX.dirty], [nJudge, '要你判斷', HEX.judge]]
  const gap = 12, cw = (W - gap * 2) / 3, h = 104
  const body = cards.map(([n, label, c], i) => {
    const x = i * (cw + gap)
    return `<rect x="${x + 1}" y="1" width="${cw - 2}" height="${h - 2}" rx="12" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="2"/>`
      + `<text x="${x + cw / 2}" y="56" text-anchor="middle" font-size="44" font-weight="700" fill="${c}">${n}</text>`
      + `<text x="${x + cw / 2}" y="86" text-anchor="middle" font-size="17" fill="${c}">${label}</text>`
  }).join('')
  return { body, h }
}

const tilesSvg = (rows: WrapupRow[]) => {
  const gap = 12, colsN = 3, tw = (W - gap * (colsN - 1)) / colsN, th = 94
  const rowsN = Math.ceil(rows.length / colsN)
  const h = rowsN * th + (rowsN - 1) * gap
  // A CJK glyph is one cell, ASCII half a cell; 11.5 cells fit a line, the rest wraps once.
  const wrap2 = (t: string, max = 11.5) => {
    const out: string[] = ['']; let w = 0
    for (const ch of t) {
      const cw = /[\x00-\x7f]/.test(ch) ? 0.5 : 1
      if (w + cw > max) { if (out.length === 2) { out[1] = out[1].replace(/.$/, '…'); break } out.push(''); w = 0 }
      out[out.length - 1] += ch; w += cw
    }
    return out.map(l => l.trim())
  }
  const body = rows.map((r, i) => {
    const x = (i % colsN) * (tw + gap), y = Math.floor(i / colsN) * (th + gap), c = HEX[r.state]
    return `<rect x="${x + 1}" y="${y + 1}" width="${tw - 2}" height="${th - 2}" rx="10" fill="${c}" fill-opacity="0.14" stroke="${c}" stroke-width="2"/>`
      + `<text x="${x + 14}" y="${y + 32}" font-size="17" font-weight="700" fill="${c}">${MARK[r.state]} ${esc(r.name)}</text>`
      + wrap2(r.short).map((l, j) => `<text x="${x + 14}" y="${y + 60 + j * 20}" font-size="14" fill="${c}">${esc(l)}</text>`).join('')
  }).join('')
  return { body, h }
}

// One picture: three number cards on top, the six tiles below.
const panelSvg = (rows: WrapupRow[], nClean: number, nDirty: number, nJudge: number) => {
  const k = kpiSvg(nClean, nDirty, nJudge), t = tilesSvg(rows), gap = 16
  const h = k.h + gap + t.h
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${h}" width="${W}" height="${h}" font-family="-apple-system, 'PingFang TC', sans-serif">${k.body}<g transform="translate(0 ${k.h + gap})">${t.body}</g></svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'wrapup', description: '收工六項自檢：分支、推拉、版號、驗證、殘留、交接' })
    await $.tool.register({
      name: 'resolve',
      description: 'Wrap-up self-check: after you have handled a yellow item of the wrap-up pane, report it here so the tile turns green. '
        + 'Give the item name exactly as the pane shows it, and one short sentence in Traditional Chinese, from the user\'s point of view, saying what you did. '
        + 'A red item cannot be resolved here: fix it, and the next check sees it gone. Leave an item unresolved only when the user has to decide it.',
      inputSchema: {
        type: 'object',
        properties: {
          item: { type: 'string', enum: NAMES },
          done: { type: 'string', description: 'What you did, one sentence, at most 40 characters' },
        },
        required: ['item', 'done'],
      },
    })
    // Taken once per session and not awaited: docker and lsof can take seconds, and a session
    // start must not wait on them. The residue check says so if it runs before this finishes.
    if (!(await read($, baseline)).takenAt) void snapshot($)
    return next(e)
  })

  // Count test commands and background commands; the wrap-up looks back at both.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId === undefined) {
      if (TEST_CMD.test(e.command)) await update($, counts, c => ({ ...c, tests: c.tests + 1 }))
      if ((e as any).run_in_background === true) await update($, counts, c => ({ ...c, background: c.background + 1 }))
    }
    return next(e)
  })

  // The user says they are wrapping up: run the checks, open the pane, then let the model
  // answer with the result in front of it.
  // The model reports a yellow row it handled. The checks run again first, so the answer is
  // about the machine now: a row that went red is refused, a row already green needs nothing.
  on('tool.call', { tool: RESOLVE_TOOL }, async ($, e) => {
    const input = e as any
    const item = String(input.item ?? '')
    const done = String(input.done ?? '').trim().slice(0, 60)
    if (!NAMES.includes(item)) return { deny: `面板上沒有「${item}」這一項。面板上的六項是：${NAMES.join('、')}` }
    if (!done) return { deny: '要用一句話寫出你對這一項做了什麼' }
    const before = (await runChecks($)).rows.find(r => r.name === item)!
    if (before.state === 'dirty') return { deny: `「${item}」還是紅色：${before.lines.join('；')}。處理完之後，下一次檢查就會變綠。` }
    if (before.state === 'judge') {
      const at = await $.clock.now()
      await update($, resolved, list => [...list.filter(r => r.name !== item), { name: item, done, at, seen: before.lines.join('\n') }])
    }
    const { rows } = await runChecks($)
    const left = rows.filter(r => r.state !== 'clean')
    return { result: left.length ? `「${item}」已經變綠。還沒變綠的有：${left.map(r => `${r.name}（${r.short}）`).join('、')}` : `「${item}」已經變綠，六項都是綠色。` } as any
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the user's own words count. A background task's notice, another session's message
    // or a scheduled prompt can quote "wrap-up" without anyone wrapping up.
    if (NOT_THE_USER.has(String((e as any).origin?.kind ?? ''))) return next(e)
    if (!TRIGGER.test(e.text)) return next(e)
    // A new wrap-up starts from what the machine looks like now: whatever was handled last
    // time has to be handled again if it is still there.
    await update($, resolved, () => [])
    const { rows, at } = await runChecks($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    const text = summary(rows, at)
    return next({ ...e, context: [...(e.context ?? []), `${text}\n（這是收工自檢剛跑完的六項結果，面板已經開給使用者看了。每一格都要處理到綠色再回話：紅色的直接處理掉；黃色的查清楚、處理完，就呼叫 ${RESOLVE_TOOL}，用一句話寫你做了什麼，那一格會變綠。只有真的要使用者決定的那一格可以留著。待辦與交接這一項，要用 ownmind 工具查過交接單。全部處理完再回報，只講兩句：東西收好了沒有；有沒有一件要他決定的事，沒有就說沒有。處理過程不要寫進回報。）`] })
  })

  on('command.run', { command: 'wrapup' }, async $ => {
    const { rows, at } = await runChecks($)
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    return { text: summary(rows, at) }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Box, Button, Text } = ui
    const r = await read($, report)
    const open = await read($, openRows)
    const cols = Math.max(30, e.props.bodyColumns ?? 60)
    const color = (s: WrapupRow['state']) => s === 'clean' ? 'green' : s === 'dirty' ? 'red' : s === 'judge' ? 'yellow' : 'gray'
    const nClean = r.rows.filter(x => x.state === 'clean').length
    const nDirty = r.rows.filter(x => x.state === 'dirty').length
    const nJudge = r.rows.filter(x => x.state === 'judge').length
    const barW = Math.min(cols - 2, 40)
    const seg = (n: number) => Math.round((barW * n) / 6)
    const toggle = (i: number) => update($, openRows, list => list.includes(i) ? list.filter(x => x !== i) : [...list, i])
    const header = (
      <Box flexDirection="row" gap={1}>
        <Text dimColor>{r.at ? `${clock(r.at)} 查的` : '還沒查過'}</Text>
        <Box flexGrow={1} />
        <Button key="wrapup-rerun" label="再查一次" dimColor onPress={() => { void runChecks($) }} />
        <Button key="wrapup-close" label="關閉" role="dismiss" dimColor onPress={() => $.ui.close({ id: PANE })} />
      </Box>
    )
    const summaryText = `六項裡 ${nClean} 項乾淨，${nDirty} 項待處理，${nJudge} 項要你看`

    // Desktop: the number cards and tiles as one SVG, then only the red and yellow items.
    if (e.surface !== 'terminal' && r.rows.length > 0) {
      const { Svg } = ui
      const todo = r.rows.filter(x => x.state === 'dirty' || x.state === 'judge')
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Svg source={panelSvg(r.rows, nClean, nDirty, nJudge)} alt={`${summaryText}。${r.rows.map(x => `${x.name}：${x.short}`).join('；')}`} />
          {todo.length > 0 && (
            <Box flexDirection="column">
              <Text bold>待處理事項</Text>
              {todo.map(x => (
                <Box flexDirection="column">
                  <Text color={color(x.state)}>{MARK[x.state]} {x.name}</Text>
                  {x.lines.map(l => <Text dimColor wrap="wrap">　{l}</Text>)}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )
    }

    // Terminal: one row per check; pressing the name or the arrow expands its detail.
    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {r.rows.length === 0 && <Text dimColor>打「收工」或 /wrapup 就會跑六項檢查</Text>}
        {r.rows.length > 0 && (
          <Box flexDirection="column">
            <Text>{summaryText}</Text>
            <Box flexDirection="row">
              <Text backgroundColor="green">{' '.repeat(seg(nClean))}</Text>
              <Text backgroundColor="red">{' '.repeat(seg(nDirty))}</Text>
              <Text backgroundColor="yellow">{' '.repeat(seg(nJudge))}</Text>
            </Box>
            <Box flexDirection="row" gap={2}>
              <Text dimColor><Text color="green">■</Text> 乾淨</Text>
              <Text dimColor><Text color="red">■</Text> 待處理</Text>
              <Text dimColor><Text color="yellow">■</Text> 要你判斷</Text>
            </Box>
          </Box>
        )}
        {r.rows.map((row, i) => (
          <Box flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Text color={color(row.state)} bold>{MARK[row.state]}</Text>
              <Button key={`wrapup-row-${i}`} plain label={row.name} onPress={() => toggle(i)} />
              <Text color={color(row.state)} wrap="truncate-end">{row.short}</Text>
              <Box flexGrow={1} />
              <Button key={`wrapup-arrow-${i}`} plain dimColor label={open.includes(i) ? '⌄' : '›'} onPress={() => toggle(i)} />
            </Box>
            {open.includes(i) && row.lines.map(l => <Text dimColor wrap="wrap">　{l}</Text>)}
          </Box>
        ))}
      </Box>
    )
  })
}
