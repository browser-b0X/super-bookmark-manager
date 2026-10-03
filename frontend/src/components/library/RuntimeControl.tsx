import { useEffect, useState } from "react";
import { canQuit, requestQuit } from "../QuitApp";

/** "1791045588-14976922" (exe time-size) → a readable build date. */
function buildLabel(build: string): string {
  const seconds = Number(build.split("-")[0]);
  return seconds > 0 ? new Date(seconds * 1000).toLocaleString() : build;
}

/** Settings → Library & sync: the same confirmed Quit as the sidebar's power button. */
export default function RuntimeControl() {
  const [build, setBuild] = useState("");
  useEffect(() => {
    if (!canQuit) return;
    fetch("/api/runtime", { cache: "no-store" }).then(r => r.ok ? r.json() : null)
      .then(d => { if (typeof d?.build === "string") setBuild(d.build); }).catch(() => {});
  }, []);
  if (!canQuit) return null;
  return <section className="panel mt-5 p-5" aria-label="Application">
    <h2 className="text-[.9rem] font-semibold">Application</h2>
    <p className="mt-2 text-[.76rem] text-[var(--dim)]">Closing the browser leaves the app running in the background.
      Quit here, or with the power button at the bottom of the sidebar, when you are finished.</p>
    <button className="btn mt-3" onClick={requestQuit}>Quit Super Bookmark Manager</button>
    {build && <p className="mt-3 text-[.7rem] text-[var(--faint)]">Running build: {buildLabel(build)}</p>}
  </section>;
}
