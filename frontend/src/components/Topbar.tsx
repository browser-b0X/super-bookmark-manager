import { useEffect, useState, type Ref } from "react";
import { useLocation, useParams } from "react-router-dom";
import { Github, Menu, Search } from "lucide-react";

/** Where people report bugs and suggest ideas. */
export const PROJECT_URL = "https://github.com/browser-b0X/super-bookmark-manager";
import { useLibrary } from "../store/library";

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="text-[.8rem] text-[var(--dim)] max-[900px]:hidden">
      {now.toLocaleDateString(undefined, { weekday: "short", day: "numeric" })}
      {" · "}
      {now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
    </span>
  );
}

export default function Topbar({ onOpenPalette, onOpenNavigation, drawerOpen, menuRef }: {
  onOpenPalette: () => void;
  onOpenNavigation: () => void;
  drawerOpen: boolean;
  menuRef: Ref<HTMLButtonElement>;
}) {
  const location = useLocation();
  const params = useParams();
  const categories = useLibrary(s => s.categories);

  let title = "Feed";
  let sub = "New links on top, your library below";
  if (location.pathname.startsWith("/library/settings")) {
    title = "Library Settings"; sub = "Import, sync and providers";
  } else if (location.pathname.startsWith("/library/item/")) {
    title = "Saved link"; sub = "Details, notes and shelf";
  } else if (location.pathname.startsWith("/library")) {
    title = "Saved Posts";
    sub = "Library";
    const catId = (params as Record<string, string>).categoryId;
    if (location.pathname.includes("/inbox")) sub = "Library · Inbox";
    if (catId) {
      const cat = categories.find(c => c.id === catId);
      sub = `Library · ${cat?.name ?? catId}`;
    }
    if (location.pathname.includes("/tag/")) sub = `Library · tag ${(params as Record<string, string>).tagId}`;
  }

  return (
    <header
      className="shell-topbar fixed top-0 right-0 z-30 flex items-center gap-3 border-b px-5 backdrop-blur"
      style={{
        left: "var(--sidebar-w)", height: "var(--topbar-h)",
        background: "color-mix(in srgb, var(--bg) 85%, transparent)",
        borderColor: "var(--border)",
      }}
    >
      <button ref={menuRef} onClick={onOpenNavigation} className="btn shell-menu"
        aria-expanded={drawerOpen} aria-controls="mobile-navigation" aria-haspopup="dialog">
        <Menu size={16} aria-hidden="true" /> Menu
      </button>
      <div className="shell-title">
        <div className="text-[.9rem] font-semibold leading-tight">{title}</div>
        <div className="text-[.74rem] text-[var(--faint)]">{sub}</div>
      </div>
      <div className="flex-1" />
      <button onClick={onOpenPalette} className="btn shell-palette max-[720px]:hidden" style={{ minWidth: 220, justifyContent: "flex-start", color: "var(--dim)" }}>
        <Search size={14} /> Search or jump to… <span className="kbd ml-auto">Ctrl K</span>
      </button>
      <Clock />
      <a className="icon-btn shell-github" href={`${PROJECT_URL}/issues`} target="_blank" rel="noreferrer noopener"
        title="Report a bug or suggest an idea on GitHub" aria-label="Report a bug or suggest an idea on GitHub">
        <Github size={17} aria-hidden="true" />
      </a>
    </header>
  );
}
