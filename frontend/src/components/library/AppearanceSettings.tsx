import { Check, Monitor, Smartphone } from "lucide-react";
import { THEMES, usePrefs } from "../../store/prefs";

/** Settings > Appearance: the four themes as cards, and the Home layout. */
export default function AppearanceSettings() {
  const theme = usePrefs(s => s.theme);
  const setTheme = usePrefs(s => s.setTheme);
  const layout = usePrefs(s => s.homeLayout);
  const setLayout = usePrefs(s => s.setHomeLayout);
  return (
    <>
      <section className="panel p-5" aria-labelledby="theme-heading">
        <h3 id="theme-heading" className="text-[.9rem] font-semibold">Theme</h3>
        <p className="mt-1 mb-3 text-[.76rem] text-[var(--dim)]">
          Colours, type and the moving background change together. Saved on this computer; fonts ship with the app.
        </p>
        <div className="theme-cards" role="radiogroup" aria-labelledby="theme-heading">
          {THEMES.map(t => (
            <button key={t.id} role="radio" aria-checked={theme === t.id} className={`theme-card theme-card--${t.id}`}
              onClick={() => setTheme(t.id)}>
              <span className="theme-card__preview" aria-hidden="true">
                <i className="p-bar" /><i className="p-card" /><i className="p-shape" />
                <i className="p-line" style={{ top: 30 }} /><i className="p-line" style={{ top: 42, right: 20 }} />
                <i className="p-btn" />
              </span>
              <span className="theme-card__name"><b>{t.name}</b>{theme === t.id && <Check size={14} className="text-[var(--accent-text)]" aria-label="In use" />}</span>
              <span className="theme-card__note">{t.note}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="panel p-5" aria-labelledby="layout-heading">
        <h3 id="layout-heading" className="text-[.9rem] font-semibold">Home layout</h3>
        <p className="mt-1 mb-3 text-[.76rem] text-[var(--dim)]">Also in the top bar. Remembered on this computer.</p>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby="layout-heading">
          <button role="radio" aria-checked={layout === "portrait"} className={`seg${layout === "portrait" ? " is-active" : ""}`} onClick={() => setLayout("portrait")}>
            <Smartphone size={13} aria-hidden="true" /> Portrait: one centred column
          </button>
          <button role="radio" aria-checked={layout === "wide"} className={`seg${layout === "wide" ? " is-active" : ""}`} onClick={() => setLayout("wide")}>
            <Monitor size={13} aria-hidden="true" /> Wide: deck beside Up next
          </button>
        </div>
      </section>
    </>
  );
}
