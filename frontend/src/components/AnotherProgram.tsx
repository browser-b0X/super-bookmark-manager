import { createPortal } from "react-dom";
import { Power, TriangleAlert } from "lucide-react";
import { useApp } from "../lib/publicRuntime";

/**
 * What a tab shows when the app at its address hasn't proved itself (lib/publicRuntime). Outside the app's root, which
 * is inert meanwhile, so nothing on the page can be used. "Isn't answering" sits under the Quit screen, which says more.
 * A page from an earlier run reloads when the app is back; a page of this run just carries on.
 */
export default function AppAnswer() {
  const state = useApp(app => app.state);
  if (state === "impostor") {
    return createPortal(
      <div className="quit-screen" role="alertdialog" aria-modal="true" aria-labelledby="another-program-title">
        <div className="quit-screen__card">
          <TriangleAlert size={28} aria-hidden="true" />
          <h1 id="another-program-title">Another program is answering at this address</h1>
          <p>SuperBookmarks has stopped and something else took its place, so this tab stopped too and sent it nothing.
            Your library is safe. Close this tab and open SuperBookmarks from the Start Menu.</p>
        </div>
      </div>, document.body);
  }
  if (state === "gone") {
    return createPortal(
      <div className="quit-screen quit-screen--below" role="alertdialog" aria-modal="true" aria-labelledby="not-answering-title">
        <div className="quit-screen__card">
          <Power size={28} aria-hidden="true" />
          <h1 id="not-answering-title">SuperBookmarks isn't answering</h1>
          <p>It may have stopped. This tab sends nothing until it's back, and carries on by itself when it is. To start it,
            open SuperBookmarks from the Start Menu.</p>
        </div>
      </div>, document.body);
  }
  return null;
}
