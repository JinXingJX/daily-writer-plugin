# Daily Writer Plugin

A long-form fiction workbench for Daily, built for manuscripts from a few chapters up to 10 million characters.

## The interface

Ink is the author's; vermilion is the AI's. Anything vermilion is proposed and not yet in the manuscript, and turns to ink once accepted.

- **Three rooms**: 写作 (spine, page, margin), 故事 (thread score, cards, world map, structure graph and the story plan as lenses) and 档案 (dossiers read as of any chapter, the bible, world, conflicts and memory).
- **The margin**: 朱批 sit level with the paragraph they concern and collect comments, notes written at publish time, continuity conflicts, story health and pending proposals. 对谈 is the conversation and 本章 holds the chapter's cast, due threads and tools. One composer serves all of them, scoped to 选区, 本章 or 全书; `/` lists commands.
- **Selection**: actions and candidates appear in the margin beside the line. The current candidate stands in place on the page (Tab accepts, ⌥] cycles).
- **Review**: a proposal opens on the page, and each change is taken or left beside its line.
- **写下一章**: the conversation beside an editable plan, through direction, plan, scene-by-scene drafting and self-review.
- **编辑部**: what ran after publishing and what is waiting on the author.

## What it does

- **Writing**: volumes and chapters (drag to reorder, virtualized tree), CodeMirror editor with per-document undo, find/replace, focus and typewriter modes, chapter targets, daily goals, autosave with three-way merge, and version history with diff and restore.
- **Story bible**: characters, factions, relationships and plot nodes; a story map and a relationship graph (`@xyflow/react`); a corkboard view of chapter cards.
- **Images** (`src/images`): illustrations sit in the text on their own line as `![图注](image:<id>)`, shown in place on the page and in preview, and exported with working relative links; they do not count as words or make a chapter's memory stale. Characters, factions, story nodes, memory entities, powers, secrets and map records each take images through owner keys in the work's image library. Images are generated natively with GPT Image 2.6 (the host's `image.generate`; the key never reaches the plugin), from a prompt the model can draft from the passage and the bible, with a per-work art style and reference images for keeping a character's look. The assistant has `generateImage` and `listImages`. Key lookup: an official OpenAI provider in Daily, `OPENAI_API_KEY`, then `~/.config/gpt-image-2-6/credentials.env`.
- **World map** (`src/atlas`, 故事 · 世界地图): each map can be painted as one continuous, artistic scroll, in four steps that each look at what came before. (1) An **overview**: one 2240×1568 picture of the whole map from its layout sketch (a detail map also sees its region in the parent; an interior sees its place's pictures), which fixes composition, colour and the look of every region. (2) The **base map**: 4×3 overlapping tiles painted from the centre outwards, each from its crop of the overview, its own sketch and the tiles already painted beside it; tiles fade into each other and each shows as soon as it lands. (3) **Blocks**: any region painted again on its own from the overview and base crops, either blended into the base (feathered edge) or set apart (cut to the region with an inked border); the edge can be switched afterwards. (4) **Tokens**: places show a small building picture, characters their avatar, items their thumbnail — made as a transparent 3×3 sheet sliced and trimmed in the plugin, one by one on transparent backgrounds (following the owner's base picture), or cropped from the painted scroll at no cost. Tokens are ordinary library images with a role: every owner can hold a base picture and an avatar/thumbnail/map token, and any other images with tags, an optional chapter and a note. A place can get an **interior map** (halls, courts, rooms) drawn from what the book says happens there; events inside roll up to the place on the outer map, and double-clicking the place opens it. A tile can be repainted alone (earlier versions are kept and can be restored) or painted as a variant that takes over from a chapter or moment, so the scroll changes with the story (a forest burned, a city fallen) without being repainted whole. Styles live in a per-work library with eleven presets and full create/edit/hide/delete; each holds a prompt, things to avoid, a palette that also colours the vector map, and reference images. On the map, characters (positioned by their latest event), items (with holders and places over time), places, events, routes, terrain changes and territory all follow the timeline, which runs from history before the book through the chapters to what the outline still plans. Maps are listed as top-level maps and sub-maps; the layout comes from the settings, outline, story memory and optional reference images, and can be redrawn, revised from an instruction or edited by hand. AI layout passes land in a draft shown in vermilion for the author to adopt; records the author or the assistant set by hand survive every later pass. The assistant reads and edits all of this (`readAtlas`, `updateAtlas`, `generateAtlas` with `overview`, `scroll`, `block`, `tokens`, `variant` and `interior` modes).
- **Story memory** (`src/memory`): every chapter is distilled into a *chapter card* (summary, scenes, character changes, facts with quotes, thread events, hook, plus emotion beats, payoffs, what changed, who learned what, closeness shifts and new cast). Cards are reduced into arcs, then volumes, then the book outline, plus a sourced worldview and entity dossiers. Threads are typed as foreshadowing, reader expectations or mysteries, with a tier, progress, payoff plan and successors. Edited chapters are re-extracted incrementally.
- **Story plan** (`src/story`, the 故事 view): the book's core promise and opening checklist, powers ("golden fingers") with their rules, costs and status ladder, hidden truths with their social ripples and a who-knows-what matrix, two-track relationships (public status vs. closeness), and per-volume endpoints, thresholds and core loops. A deterministic **story health** check flags expectation gaps, expectations about to pay off without a successor, stale foreshadowing, repeated payoff types, overlong emotional suppression, chapters that change nothing, cast overload, relationship jumps, weak thresholds and early reveals. All thresholds are adjustable.
- **Publish pipeline** (`src/pipeline`, the 编辑部 view): "发布本章" runs in the background (the plugin activation, independently of which page is open): memory upkeep → story/bible/setting updates (as reviewable proposals, or auto-applied for threads and relations) → story health → simulated reader → author briefing → margin notes on the published chapter (the 页边朱批 step, one extra model call; on by default for new works, opt in under 作品设置 for existing ones) → next-chapter plan (optionally waiting for approval) → scene-by-scene draft → review with automatic revision → a draft proposal for the next chapter. Runs can be paused, resumed, cancelled; any step can be re-run alone (dependants become stale) or with its dependants, or skipped. Drafting resumes at the next unwritten scene. Memory builds run through the same engine.
- **AI**:
  - **Writing goal** (`writer.goal`, 作品设置 → 提示词 → 创作目标): every call that writes, plans or judges the story starts from one goal instead of a list of rules: a best-selling long web serial, described by what readers get from it — outcomes they accept because every turn was earned (rigorous logic), a world with a genuinely new idea at its root that keeps generating plot, a voice that grows from that world, and a pull to the next chapter. Readers should follow who acts, who speaks and why on one read. The aim is less effort for readers, preserving facts, causal links and the author’s voice, rather than fewer words. Material from daily life, absurd modern incidents, the news or classic tropes is used for its kernel only; the events are overturned and rewritten into the work's world. The rest is left to the model's judgement; the author's intent and conventions come first. Works aiming elsewhere rewrite the goal.
  - **Fast channel** (`model.invoke`): rewrites the selection inline with multiple candidates (Tab accepts, ⌥] cycles) and continues writing at the cursor as ghost text (⌘J).
  - **Deep channel** (`agent.task`): a conversational assistant with a short system prompt, memory tools (`searchMemory`, `readEntity`, `grepManuscript`, …) and anchored edits. It may create its own sub-agents (`agent.create`, then `subagent.<id>`; host-side agent-as-tool) for drafting, reviewing or research; they share the run's context blocks and draft and are kept with the conversation.
  - **Craft on demand** (`src/ai/craft/library.ts`, `src/ai/agentTools/craft.ts`): the writing methods are a toolbox, not a procedure. One card per craft topic (moves, self-checks, when not to use it, opposing views), distilled from the 龙空写作技巧精选 notes plus cards for the world and for a voice that fits it, is looked up with `readCraft` by topic or by the author's complaint; the work's own craft conventions come first. `checkPlan` (plan lint), `reviewChapter` (editor review or checklist groups) and `diagnoseBlock` give the assistant the studio's checks when it chooses to use them. When the author settles on a different way of writing, the assistant can suggest a convention, which the author files to the notebook with one click.
  - **Next-chapter studio**: directions (inspiration) → editable plan: first the offstage reasoning for the writer (what every party wants, knows and is doing, which rules of the world come into play) and the kernel the chapter's events were drawn from, then scenes (cause, what the POV character wants, what stands in the way, the choice, what changes; stakes, deadline, what readers know that the character does not, emotion and material when they help), checked by a light plan lint (goal, change, hook, expectation handoff, repeated payoffs, long suppression, three or more new faces arriving in one scene, and the per-chapter cast limit) → scene-by-scene drafting → review against the goal (continuity, knowledge leaks against the who-knows-what table, logic, use of the world, plan, reader pull, clarity, voice; whole-chapter problems are left to the author) → per-issue revision. Drafting, review and the assistant’s plan result receive a 【读者记得多少】 block for unfamiliar characters and those last seen 20 or more chapters ago, using only appearances before the target chapter; aliases count as one person.
  - **Readability hints** (`src/domain/readability.ts`): flag clauses over 35 characters without a pause, three or more 的 modifiers in one clause, some abstract-subject expressions, and six or more consecutive speech-only paragraphs. Comparable rates in the work’s style samples suppress that kind of hint. Hints point the editor at places to check; they never become issues or edits by themselves. `clarity` issues require an exact quote and the editor’s judgement. Pipeline review records raw counts before and after revision as “难读提示 a→b（自动检测）”. Counts can overlap and include intentional style; a lower number alone does not establish better comprehension.
  - **Simulated readers**: each member retells the chapter in two or three sentences (`retell`, shown as “复述”). The editor checks those retellings against the chapter text, separating mistaken events or motives from deliberate mysteries and ordinary omissions. These are model simulations with the chapter still in context, not measured human recall or a verified no-rereading experiment.
  - **Block doctor**: tells "no plot", "no way in", "can't phrase it" and "no energy" apart and answers with three branches, an emotion plus ways in, a placeholder (`【待补：…】`, flagged at export) or a minimal task.
  - **Whole-book tools**: Q&A with chapter citations, search and replace, impact analysis, and AI batch edits.
- **Style samples** (`src/storage/sampleStore.ts`, `src/ai/styleSamples.ts`, 作品设置 → 样章): the work's voice is a few sample chapters, not a written style prompt. Every prose call gets the samples' text (cut to a budget at sentence ends) and works out the voice itself; the assistant can page through them with `readStyleSamples`.
- **Per-work prompts** (`src/ai/promptRegistry.ts`): the writing goal, role, task prompts (plan, scene, continue, rewrite, revise, review…), the assistant's system prompt, inspiration lenses and quick actions can be overridden per work in 作品设置 → 提示词. JSON output shapes stay fixed in code.
- **Inspiration burst** (`src/ai/pipelines/inspire.ts`): ⌘⇧I or the 灵感 buttons give batches of ideas for any module (root docs, chapter, selection, next-chapter direction, scene, title, characters, factions, map nodes, relations, threads, premise). Each idea uses a different lens; ideas can be adopted in place, expanded, blended, saved to the per-work idea box (`projects/<id>/ideas.json`), or handed to the assistant.
- **Safety**:
  - AI edits become proposals. You can accept them per change or per paragraph, and they are snapshotted before applying, so undo takes one click.
  - Stale proposals fail per change instead of overwriting newer text.
  - Network, storage and workspace access go through the Daily host bridge only (no direct Node.js or Electron access).

## Architecture

```
src/
  domain/   pure model logic: normalize/migrate, patch operations, documents, ranks, text diff, anchors, three-way merge
  storage/  host IO: split project store (project.json + chapters/*.md), snapshots, stats, proposals, export, book search/replace
  memory/   story memory: schema, file store, extraction, entity/thread ledger, retrieval (aliases, BM25, facts as of a chapter), aggregation, conflicts, cost estimates
  images/   image library, generation, prompt drafting, markup in text
  atlas/    world map: schema, layout geometry, timeline, operations, draft store
  story/    story plan: schema and operations, card → plan ledger, selectors (expectations, relevant threads, who knows what), health checks, plan lint
  pipeline/ background runs: schema, store and command queue, engine (lease, pause/resume/re-run/skip), step executors, run templates
  ingest/   manuscript import (UTF-8/GB18030, chapter/volume detection)
  ai/       model client, prompt registry/defaults/composition, style samples, craft checklist, budgeted context builder, quick actions, agent + tool handlers (agentTools/), pipelines (plan/next chapter, block doctor, checklist review, inspiration, QA, batch edit, impact, briefing and simulated reader)
  ui/       React app (controller hook, editor, rail, views, assistant, dialogs)
  worker/   activation-owned task and pipeline handlers
```

Storage layout (plugin-private files, schema v3):

```
projects/<id>/project.json        metadata, bible, comments, settings, prompts
projects/<id>/chapters/<id>.md    chapter bodies
projects/<id>/proposals.json      AI proposals (pending and history)
projects/<id>/story.json          story plan
projects/<id>/notebook.json       author notes, briefing, reader snapshots
projects/<id>/memory/             chapter cards (64 shards), entities, threads, aggregates, conflicts, status
projects/<id>/pipeline/           run index, one file per run, per-step artifacts
projects/<id>/snapshots/          version history
projects/<id>/samples/            style samples: index.json and one .txt per sample
projects/<id>/ideas.json
projects/<id>/images/             index.json (library, art style) and files/ (generated and uploaded images)
projects/<id>/atlas/              atlas.json, draft.json (pending AI changes), history.json
runs/                             agent checkpoints
```

Assistant conversations live in host agent sessions. Projects saved by an older Writer (schema v1/v2) are not read; they are listed as outdated and their text has to be imported again.

The design rationale and validation limits are recorded in [Reader effort](docs/reader-effort.md).

## Development

Use Node.js 22.12 or newer.

```bash
npm ci
npm test                                    # unit + integration tests (fake host)
SCALE=1 npx vitest run src/scale.test.ts    # 10M-character scale check
npm run build                               # tsc + ES module bundle + bundle verification
```

`npm run dev` serves the plugin at `http://127.0.0.1:5174`. Install the project directory or `.daily-plugin/plugin.json` in Daily. Production output is `.daily-plugin/dist/plugin.js` and is excluded from source control.


## 文风检测与最小改写

页边“本章”里的 **文风检测** 提供有原文证据的检测报告，确认建议后生成局部修改并复测，最后在页边“朱批”里打开，到稿纸上逐处采纳或撤销。原“去 AI 味”选区操作也进入这个流程，检测范围为当前整篇文档。比喻、拟人、正常排比和作者已有风格默认保留。

方法来源、检测口径、保护边界与验证说明见 [文风检测](docs/tone-review.md)。

## Source setup and Windows

Clone `https://github.com/JinXingJX/daily.git` into a sibling folder named `daliy` before `npm ci`: the shared SDK is `file:../daliy/packages/plugin-sdk`. See the [complete Windows guide](https://github.com/JinXingJX/daily/blob/main/docs/windows.md). CI checks Linux, macOS and Windows and provides a built `.daily-plugin` artifact.

Only the five original genre samples are distributed. Collected third-party passages and local scratch files stay out of the repository and production bundles. Import additional samples only when you have permission to use them.

## License

[MIT](LICENSE). Dependencies retain their own licenses.
