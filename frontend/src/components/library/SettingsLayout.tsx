import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

export const SETTINGS_SECTIONS = [
  { id: "sources", label: "Sources" },
  { id: "ai", label: "AI & previews" },
  { id: "library", label: "Library & sync" },
  { id: "backup", label: "Backup" },
] as const;

export function SettingsGroup({ id, title, icon, intro, children }: {
  id: string; title: string; icon: ReactNode; intro: string; children: ReactNode;
}) {
  return (
    <section id={id} className="settings-group" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="settings-group__title">
        <span className="text-[var(--accent)]">{icon}</span> {title}
      </h2>
      <p className="mb-3 text-[.76rem] text-[var(--faint)]">{intro}</p>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  );
}

/** Sticky section list; highlights the group in view and honours #hash links. */
export function SettingsNav() {
  const { hash } = useLocation();
  const [active, setActive] = useState<string>(SETTINGS_SECTIONS[0].id);

  useEffect(() => {
    const id = hash.slice(1);
    if (!id) return;
    // Wait a frame so lazily rendered panels (e.g. unsaved changes) exist.
    const raf = requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(raf);
  }, [hash]);

  useEffect(() => {
    const groups = SETTINGS_SECTIONS.map(s => document.getElementById(s.id)).filter((el): el is HTMLElement => !!el);
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActive(visible[0].target.id);
    }, { rootMargin: "0px 0px -65% 0px" });
    groups.forEach(g => observer.observe(g));
    return () => observer.disconnect();
  }, []);

  return (
    <nav className="settings-nav" aria-label="Settings sections">
      {SETTINGS_SECTIONS.map(s => (
        <a key={s.id} href={`#${s.id}`} aria-current={active === s.id ? "true" : undefined}
          onClick={e => {
            e.preventDefault();
            document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" });
            history.replaceState(null, "", `#${s.id}`);
            setActive(s.id);
          }}>{s.label}</a>
      ))}
    </nav>
  );
}
