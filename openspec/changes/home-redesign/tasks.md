# Tasks — home redesign

- [x] `src/routes/me-overview.js`: rules (rate, previous rate, top three missed with titles,
      unreported sessions), team (admin only), recent decisions with the left-off count;
      drop the tiles and the daily chart queries
- [x] `client/src/pages/Home/overview-vm.js`: headline, rules card, team verdicts and order,
      decisions (max five, newest first), footer lights
- [x] `client/src/pages/Home/HomePage.jsx`: the five blocks; verdict under the name at phone width
- [x] `client/src/i18n/{zh,en,ja}.json`: new home keys, unused home keys removed, placeholders match
- [x] tests: `tests/me-overview.test.js`, `tests/overview-numbers.test.js`
- [x] local run against the throwaway e2e stack with demo rows (admin and member, desktop and phone)
- [x] split 「AI 守規矩」 into 「我的 AI 守規矩」 and 「團隊的 AI 守規矩」 (admin: everyone pooled,
      the team's top three, the per-person table inside the same card; headline uses the team's
      numbers); `team_rules` in /api/me/overview, tests, three dictionaries, new screenshots
- [ ] Vin reviews the branch and the screenshots
- [ ] release and deploy (Vin decides the version)
