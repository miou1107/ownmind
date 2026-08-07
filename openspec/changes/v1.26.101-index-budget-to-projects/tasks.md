# Tasks

- [x] 1. Failing test first: 143 iron rules + 130 projects must list >100 projects.
      Confirmed red against v1.26.100's share-by-count allocator.
- [x] 2. Export `IRON_RULE_INDEX_CAP`; apply it where the allocator is told how
      many lines each type will accept, so the surplus is released normally.
- [x] 3. Keep the omission note computed from the real total, and test it.
- [x] 4. Test that a user with fewer rules than the cap loses nothing and gets
      no omission note.
- [x] 5. Break it on purpose: removing the cap, and ignoring it while counting,
      both turn the suite red.
- [x] 6. Full suite, CHANGELOG, FILELIST, README + zh-TW + ja, version bump.
