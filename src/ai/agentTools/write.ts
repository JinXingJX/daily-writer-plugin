// Tools that edit the run's draft; every edit becomes a change of the final proposal.
import { locateUnique, replaceRange } from "../../domain/anchors";
import { docKey } from "../../domain/documents";
import { uniqueId } from "../../domain/ids";
import { applyOperation, describeOperation, parsePatchOperations } from "../../domain/operations";
import { stringValue, trimmedString, unixTimestamp } from "../../domain/util";
import type { CommentSeverity, DocRef } from "../../types";
import { createChapter, docRef, docText, recordText, type RunState, type ToolHandler } from "./state";

const replaceText: ToolHandler = async ({ state, input }) => {
  const ref = docRef(state, input);
  const before = await docText(state, ref);
  const replacement = stringValue(input.replacement);
  if (input.useSelection === true || (!input.quote && state.selection && !state.selection.consumed && docKey(state.selection.doc) === docKey(ref))) {
    const selection = usableSelection(state, ref, before);
    const range = { start: selection.start, end: selection.end };
    const outcome = recordText(state, ref, before, replaceRange(before, range, replacement), stringValue(input.summary) || "改写原文");
    // What the author selected is now the replacement; useSelection again revises it.
    state.selection = { ...selection, start: range.start, end: range.start + replacement.length, text: replacement };
    return outcome;
  }
  const located = locateUnique(before, stringValue(input.quote), trimmedString(input.contextBefore));
  if (!located.ok) throw new Error(located.message);
  return recordText(state, ref, before, replaceRange(before, located.range, replacement), stringValue(input.summary) || "改写原文");
};

const insertText: ToolHandler = async ({ state, input }) => {
  const ref = docRef(state, input);
  const before = await docText(state, ref);
  const text = stringValue(input.text);
  let at = before.length;
  const position = stringValue(input.position);
  if (position === "start") at = 0;
  else if (position === "selection") {
    at = usableSelection(state, ref, before, "放置光标或选区").end;
  } else if (position === "after_quote") {
    const located = locateUnique(before, stringValue(input.quote));
    if (!located.ok) throw new Error(located.message);
    at = located.range.end;
  }
  const glue = at === before.length && before && !before.endsWith("\n") && !text.startsWith("\n") ? "\n" : "";
  return recordText(state, ref, before, `${before.slice(0, at)}${glue}${text}${before.slice(at)}`, stringValue(input.summary) || "插入文本");
};

function usableSelection(state: RunState, ref: DocRef, text: string, what = "选中文字") {
  const selection = state.selection;
  if (!selection || docKey(selection.doc) !== docKey(ref)) throw new Error(`作者没有在这个文档中${what}；用 quote 定位。`);
  if (selection.consumed || text.slice(selection.start, selection.end) !== selection.text) throw new Error("作者选中的文字已被这次任务的修改改掉了，选区不再可用；用 quote 定位。");
  return selection;
}

/** Once a whole chapter is in the draft, the assistant is pointed at the review. */
const WHOLE_CHAPTER_CHARS = 1_500;
const REVIEW_HINT = "整章写完后可以用 reviewChapter 审一遍（有章纲时会对照章纲）。";

const replaceDocument: ToolHandler = async ({ state, input }) => {
  const ref = docRef(state, input);
  const before = await docText(state, ref);
  const newText = stringValue(input.newText);
  const outcome = recordText(state, ref, before, newText, stringValue(input.summary) || "重写文档");
  return ref.kind === "chapter" && newText.length >= WHOLE_CHAPTER_CHARS ? { ...outcome, observation: `${outcome.observation}${REVIEW_HINT}` } : outcome;
};

const createChapterTool: ToolHandler = ({ state, input }) => {
  const content = stringValue(input.content);
  const meta = createChapter(state, { title: stringValue(input.title), summary: stringValue(input.summary), afterChapterId: trimmedString(input.afterChapterId) ?? null }, content);
  return { observation: `已在草稿中新建章节「${meta.title}」（id=${meta.id}），${content.length} 字符。${content.length >= WHOLE_CHAPTER_CHARS ? REVIEW_HINT : ""}`, result: { chapterId: meta.id } };
};

const applyPatchOperations: ToolHandler = ({ state, input }) => {
  const operations = parsePatchOperations(input.operations);
  const draft = structuredClone(state.draft);
  for (const operation of operations) applyOperation(draft, operation);
  state.draft = draft;
  for (const operation of operations) state.changes.push({ id: uniqueId("change"), kind: "entity", label: describeOperation(operation), operation });
  return { observation: `已在草稿中执行 ${operations.length} 个设定修改。` };
};

const addComment: ToolHandler = async ({ state, input }) => {
  const ref = docRef(state, input);
  const text = await docText(state, ref);
  const quote = stringValue(input.quote);
  const start = text.indexOf(quote);
  if (start < 0) throw new Error("批注的 quote 在原文中找不到，请逐字复制原文。");
  const severity: CommentSeverity = input.severity === "error" || input.severity === "warning" ? input.severity : "info";
  state.comments.push({ id: uniqueId("comment"), doc: ref, quote, start, comment: stringValue(input.comment), severity, author: "ai", resolved: false, createdAt: unixTimestamp() });
  return { observation: "批注已添加。" };
};

const displayContent: ToolHandler = ({ state, input }) => {
  state.displays.push({ id: uniqueId("display"), title: stringValue(input.title) || "AI 展示", content: stringValue(input.content) });
  return { observation: "已展示给作者。" };
};

export const WRITE_TOOLS: Record<string, ToolHandler> = {
  "writer.replaceText": replaceText,
  "writer.insertText": insertText,
  "writer.replaceDocument": replaceDocument,
  "writer.createChapter": createChapterTool,
  "writer.applyPatchOperations": applyPatchOperations,
  "writer.addComment": addComment,
  "writer.displayContent": displayContent,
};
