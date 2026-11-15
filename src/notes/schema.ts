// Author notebook: what the author keeps track of while writing, plus cached AI output for the author's briefing and
// the simulated reader panel's reactions to a chapter. Foreshadowing plans live on memory threads (`StoryThread.plan`).
import type { WriterComment } from "../types";
import { arrayValue, asRecord, finiteNumber, nullableString, stringArray, stringValue } from "../domain/util";

export type NoteKind = "focus" | "todo" | "memo" | "craft";
export const NOTE_KINDS: NoteKind[] = ["focus", "todo", "memo", "craft"];
export const NOTE_KIND_LABELS: Record<NoteKind, string> = { focus: "重点关注", todo: "待写 / 待改", memo: "备忘", craft: "写法约定" };

export type AuthorNote = {
  id: string;
  kind: NoteKind;
  text: string;
  /** For craft decisions: how and where to do it. */
  plan: string;
  /** For craft decisions: the craft topic ("humor", "payoff", …); empty otherwise. */
  topic?: string;
  /** Chapter the note is about, if any. */
  chapterId: string | null;
  done: boolean;
  origin: "user" | "ai";
  createdAt: number;
  updatedAt: number;
};

export type BriefingStep = { title: string; detail: string; chapterId: string | null };
export type BriefingThread = { threadId: string | null; title: string; plan: string };

export type AuthorBriefing = {
  /** Fingerprint of the chapters the briefing was generated from; differs once the manuscript changes. */
  basis: string;
  /** Number of chapters covered (reading position after the last one). */
  position: number;
  progress: string;
  storySoFar: string;
  focus: string[];
  next: BriefingStep[];
  threads: BriefingThread[];
  risks: string[];
  /** Whether recent chapters drift away from the book's core promise, and how; empty when on track. */
  promiseDrift: string;
  /** Stretches where no reader expectation is active, or one ends without a successor. */
  gaps: string[];
  generatedAt: number;
};

export type ReaderItem = { title: string; detail: string };

/** Whether a reader opens the next chapter. */
export type ReaderVerdict = "keep" | "hesitate" | "drop";
export const READER_VERDICTS: ReaderVerdict[] = ["keep", "hesitate", "drop"];
export const READER_VERDICT_LABELS: Record<ReaderVerdict, string> = { keep: "继续追", hesitate: "犹豫", drop: "不追了" };

export type MarkTone = "up" | "down" | "aside";
export const MARK_TONE_LABELS: Record<MarkTone, string> = { up: "好看", down: "出问题", aside: "吐槽" };
/** A paragraph comment (段评) pinned to a line of the chapter; `quote` is empty when the line could not be found. */
export type ReaderMark = { quote: string; reaction: string; tone: MarkTone };

/** One panel member's reaction after reading the chapter text. */
export type ReaderVoice = {
  /** The panel member ("追更党", "考据党", …). */
  persona: string;
  verdict: ReaderVerdict;
  reason: string;
  /** 本章说: the gut reaction in the reader's own words. */
  comment: string;
  /** The chapter retold from memory: what happened and why. Where it differs from the chapter, the page did not get through. */
  retell: string;
  marks: ReaderMark[];
  /** What the reader suspects is coming or is behind events. */
  guesses: string[];
  /** What the reader most wants to see next, strongest first. */
  wants: ReaderItem[];
  /** What the reader did not follow, could not place or found inconsistent. */
  lost: ReaderItem[];
};

export type DigestItem = ReaderItem & { quote: string };
/** `chapter`: revise the chapter just read; `next`: handle it in the chapters to come. */
export type ReaderAction = ReaderItem & { scope: "chapter" | "next" };

/** The editor's reading of the panel, with the author's threads, hidden lines and plans in view. */
export type ReaderDigest = {
  /** What landed with several readers and should be kept. */
  worked: DigestItem[];
  problems: DigestItem[];
  /** Where readers disagree: the trade-off and what fits the book's promise. */
  splits: ReaderItem[];
  /** Guessed truths, missed clues, misreadings and expectations that clash with the author's plan. */
  intentGaps: ReaderItem[];
  actions: ReaderAction[];
};

export type ReaderSnapshot = {
  chapterId: string;
  basis: string;
  voices: ReaderVoice[];
  /** Panel members whose reading failed. */
  failed: string[];
  /** null when the summary call failed; the voices stand on their own. */
  digest: ReaderDigest | null;
  generatedAt: number;
};

export type Notebook = {
  notes: AuthorNote[];
  briefing: AuthorBriefing | null;
  /** Reader snapshots keyed by chapter id; only the most recent few are kept. */
  readers: Record<string, ReaderSnapshot>;
  /** Margin notes written when a chapter was published, keyed by chapter id; kept apart from the project so a background run never races the open draft. */
  marginNotes: Record<string, WriterComment[]>;
};

export const MAX_READER_SNAPSHOTS = 24;

export function emptyNotebook(): Notebook { return { notes: [], briefing: null, readers: {}, marginNotes: {} }; }

export function normalizeNotebook(value: unknown): Notebook {
  const stored = asRecord(value);
  const readers: Record<string, ReaderSnapshot> = {};
  for (const item of Object.values(asRecord(stored.readers))) {
    const snapshot = normalizeReader(item);
    if (snapshot) readers[snapshot.chapterId] = snapshot;
  }
  return {
    notes: arrayValue(stored.notes).flatMap((item) => normalizeNote(item) ?? []),
    briefing: normalizeBriefing(stored.briefing),
    readers,
    marginNotes: normalizeMarginNotes(stored.marginNotes),
  };
}

function normalizeMarginNotes(value: unknown): Record<string, WriterComment[]> {
  const result: Record<string, WriterComment[]> = {};
  for (const [chapterId, items] of Object.entries(asRecord(value))) {
    const notes = arrayValue(items).filter((item): item is WriterComment => typeof asRecord(item).id === "string" && typeof asRecord(item).quote === "string" && typeof asRecord(item).comment === "string");
    if (notes.length) result[chapterId] = notes;
  }
  return result;
}

export function normalizeNote(value: unknown): AuthorNote | null {
  const note = asRecord(value);
  if (typeof note.id !== "string" || !note.id) return null;
  return {
    id: note.id,
    kind: NOTE_KINDS.includes(note.kind as NoteKind) ? note.kind as NoteKind : "memo",
    text: stringValue(note.text),
    plan: stringValue(note.plan),
    ...(typeof note.topic === "string" && note.topic ? { topic: note.topic } : {}),
    chapterId: nullableString(note.chapterId),
    done: note.done === true,
    origin: note.origin === "ai" ? "ai" : "user",
    createdAt: finiteNumber(note.createdAt, 0),
    updatedAt: finiteNumber(note.updatedAt, 0),
  };
}

export function normalizeBriefing(value: unknown): AuthorBriefing | null {
  const briefing = asRecord(value);
  if (typeof briefing.basis !== "string") return null;
  return {
    basis: briefing.basis,
    position: finiteNumber(briefing.position, 0),
    progress: stringValue(briefing.progress),
    storySoFar: stringValue(briefing.storySoFar),
    focus: stringArray(briefing.focus, 20),
    next: arrayValue(briefing.next).flatMap((item) => {
      const step = asRecord(item);
      const title = stringValue(step.title).trim();
      return title ? [{ title, detail: stringValue(step.detail), chapterId: nullableString(step.chapterId) }] : [];
    }).slice(0, 12),
    threads: arrayValue(briefing.threads).flatMap((item) => {
      const thread = asRecord(item);
      const plan = stringValue(thread.plan).trim();
      return plan ? [{ threadId: nullableString(thread.threadId), title: stringValue(thread.title).trim(), plan }] : [];
    }).slice(0, 30),
    risks: stringArray(briefing.risks, 12),
    promiseDrift: stringValue(briefing.promiseDrift),
    gaps: stringArray(briefing.gaps, 12),
    generatedAt: finiteNumber(briefing.generatedAt, 0),
  };
}

/** Snapshots from before the reader panel (no `voices`) are dropped. */
export function normalizeReader(value: unknown): ReaderSnapshot | null {
  const snapshot = asRecord(value);
  if (typeof snapshot.chapterId !== "string" || !snapshot.chapterId || !Array.isArray(snapshot.voices)) return null;
  return {
    chapterId: snapshot.chapterId,
    basis: stringValue(snapshot.basis),
    voices: snapshot.voices.flatMap((item) => normalizeVoice(item) ?? []).slice(0, 12),
    failed: stringArray(snapshot.failed, 12),
    digest: snapshot.digest ? normalizeDigest(snapshot.digest) : null,
    generatedAt: finiteNumber(snapshot.generatedAt, 0),
  };
}

export function normalizeVoice(value: unknown): ReaderVoice | null {
  const voice = asRecord(value);
  const persona = stringValue(voice.persona).trim();
  if (!persona) return null;
  return {
    persona,
    verdict: READER_VERDICTS.includes(voice.verdict as ReaderVerdict) ? voice.verdict as ReaderVerdict : "hesitate",
    reason: stringValue(voice.reason).trim(),
    comment: stringValue(voice.comment).trim(),
    retell: stringValue(voice.retell).trim(),
    marks: arrayValue(voice.marks).flatMap((item) => {
      const mark = asRecord(item);
      const reaction = stringValue(mark.reaction).trim();
      const tone: MarkTone = mark.tone === "up" || mark.tone === "down" ? mark.tone : "aside";
      return reaction ? [{ quote: stringValue(mark.quote).trim(), reaction, tone }] : [];
    }).slice(0, 12),
    guesses: stringArray(voice.guesses, 8),
    wants: readerItems(voice.wants, 8),
    lost: readerItems(voice.lost, 8),
  };
}

export function normalizeDigest(value: unknown): ReaderDigest {
  const digest = asRecord(value);
  const quoted = (list: unknown): DigestItem[] => readerItems(list, 8).map((item, index) => ({ ...item, quote: stringValue(asRecord(arrayValue(list)[index]).quote).trim() }));
  return {
    worked: quoted(digest.worked),
    problems: quoted(digest.problems),
    splits: readerItems(digest.splits, 6),
    intentGaps: readerItems(digest.intentGaps, 8),
    actions: arrayValue(digest.actions).flatMap((item) => {
      const action = asRecord(item);
      const title = stringValue(action.title).trim();
      return title ? [{ title, detail: stringValue(action.detail).trim(), scope: action.scope === "chapter" ? "chapter" as const : "next" as const }] : [];
    }).slice(0, 6),
  };
}

function readerItems(value: unknown, limit: number): ReaderItem[] {
  return arrayValue(value).flatMap((item) => {
    if (typeof item === "string") return item.trim() ? [{ title: item.trim(), detail: "" }] : [];
    const record = asRecord(item);
    const title = stringValue(record.title).trim();
    return title ? [{ title, detail: stringValue(record.detail).trim() }] : [];
  }).slice(0, limit);
}

/** How many readers keep reading, hesitate or drop the book. */
export function verdictTally(snapshot: ReaderSnapshot): Record<ReaderVerdict, number> {
  const tally: Record<ReaderVerdict, number> = { keep: 0, hesitate: 0, drop: 0 };
  for (const voice of snapshot.voices) tally[voice.verdict] += 1;
  return tally;
}

/** What the panel wants next: every reader's strongest wish first, then the next ones, without repeats. */
export function panelWants(snapshot: ReaderSnapshot, limit: number): ReaderItem[] {
  const seen = new Set<string>();
  const wants: ReaderItem[] = [];
  const depth = Math.max(0, ...snapshot.voices.map((voice) => voice.wants.length));
  for (let rank = 0; rank < depth; rank += 1) {
    for (const voice of snapshot.voices) {
      const want = voice.wants[rank];
      if (!want || seen.has(want.title)) continue;
      seen.add(want.title);
      wants.push(want);
    }
  }
  return wants.slice(0, limit);
}
