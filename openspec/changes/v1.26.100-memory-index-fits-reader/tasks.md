# Tasks

- [x] 1. Reproduction test first: build an index from a realistic memory count
      (143 iron rules + 130 projects, the measured shape) and assert it fits the
      reader's budget. Confirmed red against the current builder (8 failures).
- [x] 2. Export `MEMORY_INDEX_MAX_LINES` and `MEMORY_INDEX_MAX_ENTRY_CHARS`.
- [x] 3. Add the budget allocator: even share, unused share redistributed to
      types that want more, repeated until stable.
- [x] 4. Sort entries by `updated_at` descending inside the builder.
- [x] 5. Truncate entry lines at the character cap, with a visible `…`.
- [x] 6. Emit the per-type omission note, with count and where to look.
- [x] 7. Verify the guard actually guards. Six mutations, all caught:

      | Mutation | Result |
      | --- | --- |
      | emit every entry, ignore the allocation | 6 red |
      | raise `MEMORY_INDEX_MAX_LINES` to 500 instead of fixing the size | 2 red |
      | drop the omission note (silent truncation returns) | 2 red |
      | drop the newest-first sort | 1 red |
      | drop title truncation | 2 red |
      | even split, no redistribution of the unused share | 1 red |

      The last one passed on the first attempt. The assertion was "projects got
      more than a third of the budget", which an even split between two types
      also satisfies. Rewritten to assert the budget is spent — with entries
      still queued the file should come out at its ceiling — and it then caught
      the mutation. The test was wrong, not the code.

- [x] 8. Full suite: 3473 tests, 3471 pass, 0 fail, 2 pre-existing skips.
      One failure on the way was real and unrelated to the budget: the owner's
      name appeared in a source comment, which `no-hardcoded-names-in-output`
      forbids in product code. Reworded.
- [x] 9. CHANGELOG, FILELIST, README + zh-TW + ja, version bump to 1.26.100.
      Not 1.26.99: PR #62 already claims that number and bumps package.json to
      it. Two changes sharing a version would make it impossible to tell from
      the version alone which fix a machine has.
- [ ] 10. Code review, then act on what comes back.
