# Evidence-first style review

Writer's **文风检测** uses the detect → review → approve → revise → retest method discussed in [Lieflat's article](https://x.com/lieflat_3/status/2118355780474937831) and documented in the author's [research repository](https://github.com/larashero3-dotcom/lieflat-less-ai-tone). This is an independent TypeScript implementation, not a bundled copy of the upstream skill or a reproduction of its experiments. The X page could not be fetched directly during implementation; the author's repository supplied the detailed method.

## Author workflow

1. Open a document and choose **文风检测** on the manuscript toolbar. The former **去 AI 味** selection action opens this same whole-document review (including when an existing project has a saved action with ID `deai`). The panel explicitly names the scope.
2. **开始检测** scans up to 40,000 UTF-16 code units / 600 candidates. Larger inputs fail with a split-document instruction; they are never silently truncated. Review uses the configured review model, in batches of eight, and includes the work's style guide and available style samples. Model usage scales with candidate count.
3. Review counts, original quotations, per-rule research context, concrete suggestions, retained candidates and human-review items. Every candidate receives a closed-set label, confidence, disposition and reason; missing, duplicated or invalid output fails the batch. Low confidence goes to human review. No detection call writes the manuscript.
4. Accept the default set of reviewed suggestions or deselect items. **确认建议，生成修改并复测** generates small exact-quote patches in batches of six using the prose model, then reruns both deterministic and semantic review. It creates a normal pending Writer proposal.
5. In the margin's **朱批** tab, open the proposal on the page and review differences and the before/after report, accept chosen hunks, or reject. Existing conflict checks, snapshots and undo remain in charge of applying changes. A partial application is not the text that was retested: run detection again afterward.

## Boundaries

- A/B are local review candidates; F is a model-dependent stylistic fingerprint, never an attribution signal. C (sentence-length variation and transitions) only reports observations. H (metaphor, personification, literary intention) stays with the author. X exclusions include numbered headings, “这意味着”, list introductions and generalization in place of figures.
- Rules cover contrastive reversals, announcement openers, dense enumeration, punctuation fingerprints, synonym renaming, paragraph interfaces, colon uses and consecutive sentence triplets. This is a subset of the source research. No AI percentage, statistical-significance claim or authorship inference is computed.
- Candidate units differ by rule: one sentence, one prose line, one interface or a three-sentence group. Overlap is expected; totals are not counts of erroneous sentences. Prose paragraphs currently mean nonempty Markdown source lines, not rendered paragraphs. Triplets are exhaustively enumerated within each prose line, unlike upstream's signature prefilter. Cross-line triplets, MTLD and section geometry are not implemented. Source-corpus ratios are not transplanted into these different denominators.
- Code, headings, lists, tables, quotation/dialogue lines (including multiline quotes), links and complex inline Markdown are conservatively excluded. That reduces false edits but may miss adjacent prose. Foreign-language-only prose is not fully covered by these Chinese rules.
- Style samples and guide take precedence. Figures and style patterns are not driven to zero. Existing readability telemetry still counts abstract subjects, but it no longer turns them into automatic clarity hints or contributes them to `hardSpots`.
- A rewrite must identify every accepted candidate or explicitly retain it with a reason. Only a unique contiguous quote within that candidate can change. Overlap, changed line breaks, new markup, changed Arabic/Chinese numerals, selected uncertainty tokens or registered character names fail validation. These checks cannot prove semantic equivalence: negation, causality, all facts and literary effect still require author review.
- Changing the source after diagnosis invalidates rewriting; changing it during generation prevents adding the proposal. The proposal's existing application guard checks again before writing. Cancellation stops waiting but cannot stop an already dispatched host model call.
- Diagnosis JSON is stored under plugin-private `projects/<id>/tone-reports/<report>.json`. Revision JSON stores accepted IDs, all patches (including no-ops), the retest report and proposal ID. No existing manuscript or project schema migration is needed. Reports contain manuscript text and style references and remain local through the host file bridge. There is no external reporting service.

## Modules and validation

- `src/tone/rules.ts`: shared criterion registry, scope and attribution.
- `src/tone/detect.ts`: offset-preserving candidate extraction, protected regions, closed-label validation and disposition counts.
- `src/tone/rewrite.ts`: approval selection and bounded patch validation.
- `src/tone/pipeline.ts`: model calls, batching, report persistence, retest and proposal creation.
- `src/ui/assist/ToneReview.tsx`: inline report and explicit approval state; existing `ProposalCard` handles application/undo.

Run `npm test` and `npm run build`. Tests exercise protected content, offsets, duplicate/missing classifications, low confidence, stale documents, unauthorized/ambiguous/overlapping edits, facts/structure checks, cancellation, evidence persistence and the full mock-model diagnose → proposal → retest path. Mock-model results validate orchestration, not real-model editorial quality. Assess literary usefulness separately on representative manuscripts with the author's configured provider.
