import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bookmark, Inbox, Link2, Plus, Search, Settings } from "lucide-react";
import { useLibrary } from "../store/library";
import { PLATFORM_META } from "../lib/ui";

interface Item {
  icon: typeof Search;
  label: string;
  hint?: string;
  run: () => void;
}

export default function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);
  const posts = useLibrary(s => s.posts);
  const categories = useLibrary(s => s.categories);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const items = useMemo<Item[]>(() => {
    const ql = q.toLowerCase();
    const cmds: Item[] = [
      { icon: Plus, label: "Add a link to the library…", hint: "action", run: () => navigate("/library/settings") },
      { icon: Inbox, label: "Catch up on new links", run: () => navigate("/") },
      { icon: Bookmark, label: "Go to Library", run: () => navigate("/library") },
      { icon: Settings, label: "Library settings & import", run: () => navigate("/library/settings") },
      ...categories.filter(c => !c.archived).map(c => ({
        icon: Bookmark, label: `Category: ${c.name}`, hint: "filter",
        run: () => navigate(`/library/category/${c.id}`),
      })),
    ].filter(c => c.label.toLowerCase().includes(ql));

    if (q.trim()) {
      posts
        .filter(p =>
          (p.title || "").toLowerCase().includes(ql) ||
          (p.description || "").toLowerCase().includes(ql) ||
          (p.excerpt || "").toLowerCase().includes(ql) ||
          p.url.toLowerCase().includes(ql))
        .slice(0, 8)
        .forEach(p => cmds.push({
          icon: Link2,
          label: p.title || p.url,
          hint: PLATFORM_META[p.platform].label,
          run: () => navigate(`/library/item/${p.id}`),
        }));
    }
    return cmds;
  }, [q, posts, categories, navigate]);

  useEffect(() => setSel(0), [q]);

  const run = (i: Item) => { onClose(); i.run(); };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal mt-[12vh] w-[min(600px,92vw)] overflow-hidden" role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-2 border-b px-4" style={{ borderColor: "var(--border)" }}>
          <Search size={15} className="text-[var(--faint)]" />
          <input
            ref={inputRef}
            className="w-full bg-transparent py-4 text-[.95rem] outline-none"
            placeholder="Search posts, categories, commands…"
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => {
              if (e.key === "ArrowDown") { e.preventDefault(); setSel(s => Math.min(s + 1, items.length - 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setSel(s => Math.max(s - 1, 0)); }
              if (e.key === "Enter" && items[sel]) run(items[sel]);
            }}
          />
        </div>
        <div className="max-h-[340px] overflow-y-auto p-1.5">
          {items.length === 0 && <div className="p-4 text-center text-[.8rem] text-[var(--faint)]">No results for “{q}”.</div>}
          {items.map((it, i) => {
            const Icon = it.icon;
            return (
              <button
                key={i}
                className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[.84rem] ${i === sel ? "bg-[var(--accent-bg)] text-[var(--text)]" : "text-[var(--dim)] hover:bg-[var(--surface2)]"}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => run(it)}
              >
                <Icon size={14} className={i === sel ? "text-[var(--accent)]" : "text-[var(--faint)]"} />
                <span className="flex-1 truncate">{it.label}</span>
                {it.hint && <span className="text-[.66rem] text-[var(--faint)]">{it.hint}</span>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
