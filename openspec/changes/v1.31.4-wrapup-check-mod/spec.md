# Spec — wrap-up self-check mod

## The mod

GIVEN a session in a git checkout
WHEN the user's prompt contains 收工, 收尾, 下班, 交接 or "wrap up" (any case, optional space or hyphen)
THEN the six checks run, the pane "OwnMind 收工自我檢查" opens focused,
AND the prompt reaches the model with a context block "[收工自檢 HH:MM]" split into 已乾淨 and 待辦.

GIVEN the same session
WHEN the prompt does not contain a trigger word, or contains one only as part of a longer word or phrase
  (交接文件, 下班前, 收尾一下, the mod's own name wrapup-check, the command /wrapup)
THEN nothing runs and no pane opens.

GIVEN a prompt in a folder that is not a git checkout, or a machine without git
WHEN the checks run
THEN 分支, 推拉與 stash, 版號 and 驗證與文件 are yellow and say the folder is not a git project; no green mark is drawn for them.

GIVEN the local main branch is behind origin/main while another branch is checked out
WHEN the checks run
THEN 推拉與 stash is red and names how many commits main is behind.

GIVEN `git status --porcelain` lists an unstaged change to docs/README.md
WHEN the checks run
THEN 驗證與文件 reports the docs as changed, with the path intact (issue #158).

GIVEN the newest tag is rc0.35.124 and package.json says 0.35.124
THEN 版號 does not report a mismatch, and its lines say that whether the server runs this version must be checked separately.

GIVEN a subagent whose status is failed or killed
THEN 待辦與交接 does not list it as still owed; only a running one is.

GIVEN the session started a moment ago and the baseline snapshot has not finished
WHEN the checks run
THEN 測試環境殘留 is yellow and says the baseline is not ready, rather than reporting everything as residue.

GIVEN the user runs `/wrapup`
THEN the checks run, the pane opens, and the command answers with the same text block.

GIVEN three files are not committed, two commits are not pushed, the newest tag has commits after it,
and a container appeared since session start
WHEN the checks run
THEN 分支 is red with "3 個檔沒 commit", 推拉與 stash is red with "2 個 commit 沒推",
版號 is yellow, 測試環境殘留 is red naming the container, and the context block names each.

GIVEN a clean checkout with nothing new since session start
WHEN the checks run
THEN 分支, 推拉與 stash, 版號, 驗證與文件 and 測試環境殘留 are green and no red mark is drawn.

GIVEN the pane on the terminal surface
WHEN the user presses a check's name or its arrow
THEN that check's detail lines appear below it; pressing again hides them.

GIVEN the pane on the desktop surface
THEN the three number cards and six tiles are one Svg element whose alt text carries the summary and every tile's short line.

GIVEN a container listed by `docker ps` with a compose working-directory label outside the session's cwd
WHEN the residue check runs
THEN that container is not reported.

## The installer helper

GIVEN no ~/.claude/settings.json
WHEN the helper runs
THEN the file is created with CLAUDE_CODE_PLUGIN_DIRS naming both mod folders of the checkout, in MODS order,
and CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1, and it prints OK:mods:ownmind-monitor=installed,wrapup-check=installed.

GIVEN settings listing another plugin folder
THEN that folder stays first and both mods follow it.

GIVEN the helper already ran
WHEN it runs again
THEN the file is not rewritten and it prints unchanged for both mods.

GIVEN ~/.claude/mods/wrapup-check (hand-installed) is listed
THEN it is replaced in place by the checkout's folder, so the mod is not loaded twice.

GIVEN ~/.ownmind/.no-wrapup-mod exists
THEN only the wrap-up entry is removed; the monitor entry and the user's folders stay; the line says wrapup-check=opted_out.

GIVEN the checkout has no mods/wrapup-check folder (older checkout, rollback)
THEN its entry is removed and the line says wrapup-check=missing; the monitor mod is unaffected.

GIVEN --platform win32
THEN paths are native Windows paths joined with ';' and the drive-letter colon is not read as a separator.
