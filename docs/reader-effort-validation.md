# Reader-effort validation — 2026-10-26

`npm test`: 142 passed; the opt-in 10-million-character scale test was skipped. Thirteen regression tests were added after the previous 129-test handoff. `npm run build` passed TypeScript checking, the production bundle and bundle verification.

New coverage exercises prompt wording and long-material output formats, reader reminders before the target chapter, the 20-chapter boundary, aliases, scene/chapter cast limits, free-form focal descriptions, editor judgement of heuristic hints, retell normalization and persistence, full-text context in the digest, and pipeline before/after counts. A controlled pipeline case confirms a clarity revision changes the count from 1 to 0.

A separate isolated workspace was used for a host integration run with the real Daily sidecar and Rust-validated plugin RPCs. It exercised chapter review, reader retelling, the digest, next-chapter planning, drafting, review/revision and proposal creation. The source manuscript was unchanged. Manuscripts, credentials, generated prose and detailed reports are private local data and are not distributed with this repository.

The run showed that model-generated focal descriptions could be mistaken for character names. Resolving out-of-list entries against known memory characters removed the false cast warnings; a regression test covers that case. Passing these checks establishes the tested behavior only. It does not establish better comprehension by human readers or consistent behavior across live providers.
