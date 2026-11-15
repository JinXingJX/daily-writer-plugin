# Reader effort

Writer aims to reduce the work readers do to understand a story while preserving its facts, motives, causal links, uncertainty and voice. Shorter text is not the objective. Necessary subjects, speaker names, connections and reminders should stay; repeated explanation and empty phrasing can go.

The shared `writer.goal` carries this direction through writing, planning, review, setting organization, the assistant and author notes. Prompts and checklists use ordinary language and explain the desired result. Do not reintroduce fixed cutting percentages, mandatory sensory-detail quotas or a requirement for “交互式布景”. The author’s choices and style samples remain the guide to the work’s voice.

Deterministic readability rules are inexpensive proxies adapted for Chinese prose, not validated comprehension measures. They suggest places for an editor to examine; they neither prove an error nor authorize an edit. A clause can trigger multiple rules. The pipeline therefore labels their sum “难读提示（自动检测）”, not a count of confirmed hard-to-read sentences. The before/after totals are raw and include patterns suppressed from editor hints by the style baseline.

Reader reminders and new-face warnings use appearances before the target chapter and resolve known aliases to one person. Free-form scene-focus descriptions are not character names; a focal entry outside the cast list counts only when memory resolves it to a character. Missing memory is not proof that someone has never appeared. Keep the memory current before judging these reminders on a real manuscript.

Simulated readers retell the chapter, and an editor checks their events, motives and causal links against the chapter text. The model still has the chapter in context; asking it not to reread does not make this a human memory experiment. Treat errors as leads for review, distinguish deliberate suspense from confusion, and retain facts when revising. Actual improvement needs target readers to compare comprehension, rereading and factual retention on equivalent passages.

This direction follows the user’s Claude session `4beed51b-b58e-44e1-8f2b-33234e2548ad` and its discussion of “Why is AI-generated language so hard to understand?”. The Chinese rules and product flow are engineering choices, not claims that the paper validated them.

Implementation validation is recorded in [Reader-effort validation](reader-effort-validation.md).

The later [evidence-first tone review](tone-review.md) separates figurative language from automatic readability recommendations. `abstractSubjects` remains historical telemetry, while `hardSpots` and editor hints exclude it. Personification and metaphor are for author review, not an automatic reason to rewrite a sentence.
