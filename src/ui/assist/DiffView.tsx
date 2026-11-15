import { Check } from "lucide-react";
import { useMemo } from "react";
import { diffLines, diffStats, readableInlineDiff } from "../../domain/textDiff";

type Props = { before: string; after: string; accepted?: Set<number>; onToggle?: (hunk: number) => void; maxEqual?: number };

/** Paragraph diff with inline highlights; hunks are individually selectable when `onToggle` is given. */
export function DiffView({ before, after, accepted, onToggle, maxEqual = 1 }: Props) {
  const diff = useMemo(() => diffLines(before, after), [before, after]);
  const stats = diffStats(diff);
  if (!diff.hunks.length) return <div className="w-diff-empty">没有文字改动。</div>;
  return (
    <div className="w-diff">
      <div className="w-diff-stats">{stats.hunks} 处改动 · <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span></div>
      {diff.segments.map((segment, index) => {
        if (segment.type === "equal") {
          const lines = segment.lines;
          const first = index === 0;
          const last = index === diff.segments.length - 1;
          const head = first ? [] : lines.slice(0, maxEqual).map((line) => clip(line, "head"));
          const tail = last ? [] : lines.slice(-maxEqual).map((line) => clip(line, "tail"));
          if (lines.length <= maxEqual * 2 && !first && !last) return <div key={index} className="w-diff-equal">{lines.map((line, lineIndex) => <p key={lineIndex}>{clip(line, "head") || "\u00a0"}</p>)}</div>;
          const hidden = lines.length - head.length - tail.length;
          return (
            <div key={index} className="w-diff-equal">
              {head.map((line, lineIndex) => <p key={`a${lineIndex}`}>{line || "\u00a0"}</p>)}
              {hidden > 0 ? <div className="w-diff-fold">… {hidden} 段未改动 …</div> : null}
              {tail.map((line, lineIndex) => <p key={`b${lineIndex}`}>{line || "\u00a0"}</p>)}
            </div>
          );
        }
        const { hunk } = segment;
        const isAccepted = accepted ? accepted.has(hunk.index) : true;
        const paired = hunk.before.length === hunk.after.length;
        return (
          <div key={index} className={`w-diff-hunk ${isAccepted ? "" : "rejected"}`}>
            {onToggle ? <button type="button" className={`w-hunk-toggle ${isAccepted ? "on" : ""}`} aria-pressed={isAccepted} title={isAccepted ? "点击不采用这处修改" : "点击采用这处修改"} onClick={() => onToggle(hunk.index)}>{isAccepted ? <Check size={11} /> : null}</button> : null}
            <div className="w-hunk-body">
              {paired ? hunk.before.map((line, lineIndex) => (
                <p key={lineIndex} className="w-diff-line mixed">
                  {readableInlineDiff(line, hunk.after[lineIndex]).map((part, partIndex) => <span key={partIndex} className={part.type === "insert" ? "ins" : part.type === "delete" ? "del" : ""}>{part.text}</span>)}
                </p>
              )) : (
                <>
                  {hunk.before.map((line, lineIndex) => <p key={`d${lineIndex}`} className="w-diff-line del">{line || " "}</p>)}
                  {hunk.after.map((line, lineIndex) => <p key={`i${lineIndex}`} className="w-diff-line ins">{line || " "}</p>)}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Context paragraphs are shortened: the end of the paragraph before a change, the start of the one after. */
function clip(line: string, keep: "head" | "tail", limit = 60) {
  if (line.length <= limit) return line;
  return keep === "head" ? `${line.slice(0, limit)}…` : `…${line.slice(-limit)}`;
}
