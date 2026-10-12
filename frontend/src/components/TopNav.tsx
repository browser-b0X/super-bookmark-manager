import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { Check, ExternalLink, Github, Heart, Monitor, Plus, Power, Search, Settings, Smartphone } from "lucide-react";
import { useLibrary } from "../store/library";
import { THEMES, usePrefs } from "../store/prefs";
import { canQuit, requestQuit } from "./QuitApp";
import AddLinkDialog from "./library/AddLinkDialog";
import BrandMark from "./BrandMark";

/** Where people report bugs and suggest ideas. */
export const PROJECT_URL = "https://github.com/browser-b0X/super-bookmark-manager";
/** The author's link page: ways to support the project and his other links. */
export const SUPPORT_URL = "https://bio.site/browserb0x";

const inboxCounts = new WeakMap<object, number>();
/** New (inbox) links, counted once per version of the library. */
function newLinks(posts: { status: string }[]): number {
  let n = inboxCounts.get(posts);
  if (n === undefined) { n = 0; for (const p of posts) if (p.status === "inbox") n++; inboxCounts.set(posts, n); }
  return n;
}

/**
 * The top bar of the new look: no sidebar. Home, New, Later, Favourites and
 * All shelves on the left; search, the Portrait/Wide switch, Add link and GitHub
 * on the right; Settings and everything else in the menu behind the logo.
 */
export default function TopNav({ onOpenPalette }: { onOpenPalette: () => void }) {
  // Only the number of new links: the bar re-renders when that number changes, not on every
  // background change to the library (counting every platform here kept big imports busy).
  const newCount = useLibrary(s => newLinks(s.posts));
  const views = useLibrary(s => s.views);
  const theme = usePrefs(s => s.theme);
  const setTheme = usePrefs(s => s.setTheme);
  const layout = usePrefs(s => s.homeLayout);
  const setLayout = usePrefs(s => s.setHomeLayout);
  const location = useLocation();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const params = new URLSearchParams(location.search);
  const onHome = location.pathname === "/" && !params.get("q");

  useEffect(() => { setMenu(false); }, [location.pathname, location.search]);
  useEffect(() => {
    if (!menu) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => { window.removeEventListener("mousedown", close); window.removeEventListener("keydown", close); };
  }, [menu]);

  const tab = (active: boolean) => `topnav__tab${active ? " is-active" : ""}`;
  const isStatus = (value: string) => location.pathname === "/library" && params.get("status") === value;

  return (
    <header className="topnav" aria-label="Main">
      <div className="topnav__menu" ref={menuRef}>
        <button className="topnav__avatar" aria-haspopup="menu" aria-expanded={menu} aria-label="Menu" title="SuperBookmarks menu"
          onClick={() => setMenu(m => !m)}><BrandMark size={34} /></button>
        {menu && <div className="topnav__dropdown" role="menu" aria-label="Menu">
          <button role="menuitem" onClick={() => navigate("/library/settings")}>
            <Settings size={14} /> <span>Settings<small>Sources, AI, library, backup, appearance</small></span>
          </button>
          <div className="topnav__heading" id="menu-theme">Theme</div>
          <div role="group" aria-labelledby="menu-theme" className="topnav__themes">
            {THEMES.map(t => (
              <button key={t.id} role="menuitemradio" aria-checked={theme === t.id} onClick={() => setTheme(t.id)}>
                <span className={`theme-dot theme-dot--${t.id}`} aria-hidden="true" />
                <span>{t.name}</span>
                {theme === t.id && <Check size={13} aria-hidden="true" className="ml-auto" />}
              </button>
            ))}
          </div>
          <hr />
          <a role="menuitem" className="topnav__support" href={SUPPORT_URL} target="_blank" rel="noreferrer noopener" onClick={() => setMenu(false)}>
            <Heart size={14} /> <span>Support<small>Opens bio.site/browserb0x: ways to support the project and the author's links</small></span>
            <ExternalLink size={12} className="ml-auto" aria-hidden="true" />
          </a>
          {views.length > 0 && <>
            <div className="topnav__heading">Saved views</div>
            {views.map(v => <button key={v.id} role="menuitem" onClick={() => navigate(`/library?view=${v.id}`)}><span>{v.name}</span></button>)}
          </>}
          {canQuit && <>
            <hr />
            <button role="menuitem" className="topnav__quit" onClick={() => { setMenu(false); requestQuit(); }}>
              <Power size={14} /> <span>Quit app</span>
            </button>
          </>}
        </div>}
      </div>

      <nav className="topnav__tabs" aria-label="Sections">
        <NavLink to="/" end className={({ isActive }) => tab(isActive)}>Home</NavLink>
        <NavLink to="/library/inbox" className={({ isActive }) => tab(isActive)}>
          New{newCount > 0 && <span className="topnav__badge" aria-label={`${newCount} new`}>{newCount}</span>}
        </NavLink>
        <NavLink to="/library?status=to-review" className={() => tab(isStatus("to-review"))}>Later</NavLink>
        <NavLink to="/library?status=favorites" className={() => tab(isStatus("favorites"))}>Favourites</NavLink>
        <NavLink to="/shelves" className={({ isActive }) => tab(isActive)}>All shelves</NavLink>
      </nav>

      <form className="topnav__search" role="search" onSubmit={e => {
        e.preventDefault();
        const text = query.trim();
        navigate(text ? `/library?q=${encodeURIComponent(text)}` : "/library");
      }}>
        <Search size={15} aria-hidden="true" />
        <input type="search" placeholder="Search your library" aria-label="Search your library" value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => { if (e.key === "Escape") setQuery(""); }} />
        <button type="button" className="kbd" onClick={onOpenPalette} title="Jump to anything (Ctrl K)" aria-label="Search or jump to… (Ctrl K)">Ctrl K</button>
      </form>

      {/* Only Home has a layout to choose: elsewhere the switch slides away (hidden from keyboard and screen readers too). */}
      <div className={`topnav__seg${onHome ? "" : " is-away"}`} role="radiogroup" aria-label="Home layout" aria-hidden={!onHome || undefined}>
        <button role="radio" aria-checked={layout === "portrait"} tabIndex={onHome ? undefined : -1} onClick={() => setLayout("portrait")} title="One centred column">
          <Smartphone size={13} aria-hidden="true" /> Portrait
        </button>
        <button role="radio" aria-checked={layout === "wide"} tabIndex={onHome ? undefined : -1} onClick={() => setLayout("wide")} title="Deck on the left, Up next on the right">
          <Monitor size={13} aria-hidden="true" /> Wide
        </button>
      </div>

      <button className="btn btn-primary topnav__add" onClick={() => setAdding(true)}><Plus size={14} /> Add link</button>

      <span className="hint-host">
        <a className="topnav__round" href={`${PROJECT_URL}/issues`} target="_blank" rel="noreferrer noopener"
          aria-label="Report a bug or suggest an idea on GitHub" aria-describedby="github-hint">
          <Github size={16} aria-hidden="true" />
        </a>
        <span id="github-hint" role="tooltip" className="hint-toast">
          <b>Bugs and suggestions</b>
          Opens the project's GitHub page in your browser: github.com/browser-b0X/super-bookmark-manager
        </span>
      </span>
      {/* Settings lives in the menu behind the logo (owner, mockup p10-1): no second button here. */}
      {adding && <AddLinkDialog onClose={() => setAdding(false)} />}
    </header>
  );
}
