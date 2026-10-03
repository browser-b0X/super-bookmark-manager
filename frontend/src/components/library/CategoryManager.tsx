import { useState } from "react";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Archive, GripVertical, Lightbulb, Palette, Plus, Trash2, X } from "lucide-react";
import { CAT_COLORS, useLibrary } from "../../store/library";
import type { Category } from "../../types";

/**
 * The whole point of the consolidation: a browsable library has a shelf count you
 * can hold in your head. Past this, finding a link by category stops working.
 */
const SHELF_LIMIT = 12;
const RESERVED = new Set(["other", "uncategorized"]);

interface Suggestion { name: string; reason: string; example_count: number }

function SortableRow({ cat, count }: { cat: Category; count: number }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: cat.id });
  const renameCategory = useLibrary(s => s.renameCategory);
  const recolorCategory = useLibrary(s => s.recolorCategory);
  const archiveCategory = useLibrary(s => s.archiveCategory);
  const deleteCategory = useLibrary(s => s.deleteCategory);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(cat.name);
  const [confirmDel, setConfirmDel] = useState(false);

  return (
    <div
      ref={setNodeRef}
      className={`flex items-center gap-2 rounded-lg border px-2 py-1.5 ${cat.archived ? "opacity-50" : ""}`}
      style={{
        transform: CSS.Transform.toString(transform), transition,
        borderColor: isDragging ? "var(--accent)" : "var(--border)",
        background: "var(--surface2)",
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      <button className="text-[var(--faint)] cursor-grab active:cursor-grabbing" {...attributes} {...listeners} aria-label={`Reorder ${cat.name}`}>
        <GripVertical size={14} />
      </button>
      <span className="dot" style={{ background: cat.color }} />
      {editing ? (
        <input
          className="input" style={{ padding: "2px 8px", fontSize: ".76rem" }}
          value={name} autoFocus
          onChange={e => setName(e.target.value)}
          onBlur={() => { renameCategory(cat.id, name); setEditing(false); }}
          onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") { setName(cat.name); setEditing(false); } }}
        />
      ) : (
        <button className="flex-1 truncate text-left text-[.8rem]" onDoubleClick={() => setEditing(true)} title="Double-click to rename">
          {cat.name} {cat.archived && <span className="chip ml-1">archived</span>}
        </button>
      )}
      <span className="chip">{count}</span>
      <div className="relative group/pal">
        <button className="icon-btn" style={{ width: 24, height: 24 }} title="Recolor"><Palette size={12} /></button>
        <div className="absolute right-0 z-10 hidden gap-1 rounded-lg border p-1.5 group-hover/pal:flex" style={{ background: "var(--elev)", borderColor: "var(--border-hi)" }}>
          {CAT_COLORS.map(c => (
            <button key={c} className="dot cursor-pointer" style={{ background: c, width: 14, height: 14 }} onClick={() => recolorCategory(cat.id, c)} aria-label={`Color ${c}`} />
          ))}
        </div>
      </div>
      <button className="icon-btn" style={{ width: 24, height: 24 }} title={cat.archived ? "Unarchive" : "Archive"} onClick={() => archiveCategory(cat.id, !cat.archived)}>
        <Archive size={12} />
      </button>
      {cat.id !== "uncategorized" && (
        confirmDel ? (
          <button className="btn btn-danger" style={{ padding: "2px 8px", fontSize: ".68rem" }} onClick={() => deleteCategory(cat.id)}>posts → uncategorized. sure?</button>
        ) : (
          <button className="icon-btn" style={{ width: 24, height: 24 }} title="Delete" onClick={() => setConfirmDel(true)}><Trash2 size={12} /></button>
        )
      )}
    </div>
  );
}

export default function CategoryManager({ onClose }: { onClose: () => void }) {
  const categories = useLibrary(s => s.categories);
  const posts = useLibrary(s => s.posts);
  const addCategory = useLibrary(s => s.addCategory);
  const reorderCategories = useLibrary(s => s.reorderCategories);
  const [newName, setNewName] = useState("");
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [loadingSug, setLoadingSug] = useState(false);
  const [sugMsg, setSugMsg] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const counts = new Map<string, number>();
  posts.forEach(p => p.categories.forEach(c => counts.set(c, (counts.get(c) || 0) + 1)));

  const ordered = [...categories].sort((a, b) => a.order - b.order);
  const shelfCount = categories.filter(c => !RESERVED.has(c.name)).length;
  const atLimit = shelfCount >= SHELF_LIMIT;

  const add = (name: string) => {
    const cat = addCategory(name);
    return cat;
  };

  const fetchSuggestions = async () => {
    setLoadingSug(true);
    setSugMsg(null);
    try {
      const res = await fetch("/api/categories/suggestions?limit=3");
      if (!res.ok) throw new Error("unavailable");
      const { suggestions: list } = await res.json() as { suggestions: Suggestion[] };
      const fresh = list.filter(s => !categories.some(c => c.name === s.name));
      setSuggestions(fresh);
      if (!fresh.length) setSugMsg("Nothing to suggest — the unfiled links don't form a group yet.");
    } catch {
      setSugMsg("Backend is not reachable — start the local server to get suggestions.");
    }
    setLoadingSug(false);
  };

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = ordered.map(c => c.id);
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    reorderCategories(ids);
  };

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal mt-[8vh] flex max-h-[80vh] w-[min(520px,94vw)] flex-col p-5" role="dialog" aria-label="Manage categories">
        <div className="mb-3 flex items-center">
          <h3 className="text-[.95rem] font-semibold">Manage categories</h3>
          <button className="icon-btn ml-auto" onClick={onClose} aria-label="Close"><X size={15} /></button>
        </div>
        <p className="mb-3 text-[.72rem] text-[var(--dim)]">
          Drag to reorder · double-click to rename · deleting moves posts to uncategorized.
          <span className="ml-1 text-[var(--faint)]">{shelfCount} of {SHELF_LIMIT} shelves used.</span>
        </p>
        <div className="flex-1 space-y-1.5 overflow-y-auto pr-1">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={ordered.map(c => c.id)} strategy={verticalListSortingStrategy}>
              {ordered.map(c => <SortableRow key={c.id} cat={c} count={counts.get(c.name) || 0} />)}
            </SortableContext>
          </DndContext>
        </div>
        <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-2">
            <button className="btn" onClick={fetchSuggestions} disabled={loadingSug || atLimit}
              title="Read the links that couldn't be filed and propose shelves for them">
              <Lightbulb size={13} className={loadingSug ? "animate-pulse" : ""} />
              {loadingSug ? "Reading unfiled links…" : "Suggest from unfiled links"}
            </button>
            {atLimit && <span className="text-[.68rem] text-[var(--faint)]">Shelf limit reached — remove one first.</span>}
          </div>

          {sugMsg && <p className="mt-2 text-[.7rem] text-[var(--faint)]">{sugMsg}</p>}

          {suggestions?.map(s => (
            <div key={s.name} className="mt-2 flex items-start gap-2 rounded-lg border p-2"
              style={{ borderColor: "var(--border-hi)", background: "var(--surface2)" }}>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[.8rem] font-medium">{s.name}</span>
                  <span className="chip">{s.example_count} links</span>
                </div>
                {s.reason && <p className="mt-0.5 text-[.68rem] text-[var(--dim)]">{s.reason}</p>}
              </div>
              <button className="btn btn-primary" style={{ padding: "2px 8px", fontSize: ".68rem" }}
                onClick={() => { if (add(s.name)) setSuggestions(suggestions.filter(x => x.name !== s.name)); }}>
                <Plus size={11} /> Add
              </button>
              <button className="btn" style={{ padding: "2px 8px", fontSize: ".68rem" }}
                onClick={() => setSuggestions(suggestions.filter(x => x.name !== s.name))}>
                Dismiss
              </button>
            </div>
          ))}
        </div>

        <div className="mt-3 flex gap-2">
          <input
            className="input"
            placeholder={atLimit ? "Shelf limit reached" : "New category name…"}
            value={newName}
            disabled={atLimit}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && add(newName)) setNewName(""); }}
          />
          <button className="btn btn-primary" disabled={atLimit} onClick={() => { if (add(newName)) setNewName(""); }}>
            <Plus size={13} /> Add
          </button>
        </div>
      </div>
    </div>
  );
}
