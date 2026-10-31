"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Bookmark, Check, ChevronDown, Pin } from "lucide-react";

type Source = "bookmarks" | "pinterest" | "x";
const options = [
  { value: "bookmarks" as const, label: "Bookmarks", icon: Bookmark },
  { value: "pinterest" as const, label: "Pinterest", icon: Pin },
  { value: "x" as const, label: "X bookmarks", icon: null },
];

export default function CollectionSourceSelect({ value, onChange }: { value: Source; onChange: (source: Source) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const selected = options.find(option => option.value === value)!;

  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  return (
    <div ref={root} className="relative" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
    }}>
      <button ref={trigger} type="button" aria-label="Collection source" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)} onKeyDown={event => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); }
        }}
        className="flex w-full items-center gap-2 rounded-xl border border-[#5b9888]/20 bg-white/85 px-3 py-2.5 text-sm font-medium text-[#3d7a64] shadow-sm transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-[#5b9888]">
        {selected.icon ? <selected.icon className="h-4 w-4" /> : <span aria-hidden="true">𝕏</span>}
        <span className="flex-1 text-left">{selected.label}</span>
        <ChevronDown aria-hidden="true" className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && <div id={id} role="menu" aria-label="Collection source" className="absolute left-0 right-0 top-full z-[100] mt-1 max-h-60 overflow-y-auto rounded-xl border border-gray-100 bg-white py-1 shadow-lg"
        onKeyDown={event => {
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]'));
          const index = items.indexOf(document.activeElement as HTMLButtonElement);
          if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
          else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[next]?.focus();
          }
        }}>
        {options.map(option => <button key={option.value} type="button" role="menuitemradio" aria-checked={value === option.value}
          onClick={() => { onChange(option.value); setOpen(false); trigger.current?.focus(); }}
          className={`flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-sm outline-none hover:bg-[#f1f6f4] focus:bg-[#f1f6f4] ${value === option.value ? "bg-[#edf4f1] font-medium text-[#5b9888]" : "text-gray-600"}`}>
          {option.icon ? <option.icon className="h-4 w-4" /> : <span aria-hidden="true" className="w-4 text-center">𝕏</span>}
          <span className="flex-1">{option.label}</span>
          {value === option.value && <Check aria-hidden="true" className="h-3.5 w-3.5" />}
        </button>)}
      </div>}
    </div>
  );
}
