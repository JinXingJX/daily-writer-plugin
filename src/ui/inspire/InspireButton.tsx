import { Sparkles } from "lucide-react";
import { useState } from "react";
import { InspirePanel, type InspireOptions } from "./InspirePanel";

/** A "灵感" button that opens the inspiration panel for one module. `options` is read when the button is clicked. */
export function InspireButton({ options, label = "灵感", className = "w-chip", title }: { options: () => InspireOptions; label?: string; className?: string; title?: string }) {
  const [open, setOpen] = useState<InspireOptions | null>(null);
  return (
    <>
      <button type="button" className={className} title={title ?? "灵感涌现：给出各种各样的思路"} onClick={() => setOpen(options())}><Sparkles size={13} />{label}</button>
      {open ? <InspirePanel options={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}
