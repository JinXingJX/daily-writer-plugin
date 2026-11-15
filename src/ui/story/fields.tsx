import { CommitTextarea } from "../common";

/** A labelled text field that commits on blur. */
export function TextField({ label, value, onCommit, rows = 1, placeholder }: { label: string; value: string; onCommit: (value: string) => void; rows?: number; placeholder?: string }) {
  return <label className="w-story-field"><span>{label}</span><CommitTextarea rows={rows} value={value} placeholder={placeholder} onCommit={onCommit} /></label>;
}

/** One item per line. */
export function ListField({ label, value, onCommit, placeholder }: { label: string; value: string[]; onCommit: (value: string[]) => void; placeholder?: string }) {
  return <TextField label={label} rows={Math.max(2, value.length + 1)} value={value.join("\n")} placeholder={placeholder ?? "每行一项"} onCommit={(text) => onCommit(text.split("\n").map((item) => item.trim()).filter(Boolean))} />;
}
