# Tasks — v1.31.7 wrap-up tiles handled to green

- [x] `mods/wrapup-check/hooks/register.tsx` — resolve tool, resolutions applied in runChecks, cleared on a new wrap-up, new model instruction, agy port noise
- [x] Review fixes: the tool was never declared (`$.tool.register`), resolutions keyed to the row's detail, prompts that are not the user's skipped, overlapping runs numbered
- [x] `mods/wrapup-check/types/index.d.ts` — `WrapupResolution`, `resolved` in the state contract
- [x] `mods/wrapup-check/hooks/pane.test.tsx` — resolve flow (red refused, yellow green, unknown and empty refused, cleared on a new wrap-up), agy port
- [x] Broke the refusal, the resolution guard and the agy noise once; both new tests went red
- [x] `claude plugin validate mods/wrapup-check` and `claude plugin test mods/wrapup-check`
- [x] FILELIST, README ×3
- [ ] CHANGELOG and version at release (release commit)
