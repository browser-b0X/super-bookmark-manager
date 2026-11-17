// "Kept for later": what the toolbar button or a Download button did while SuperBookmarks wasn't there to take it.
// #kept=<name> after keeping a post or page; #list when a feed's posts were asked for (nothing was chosen yet,
// so nothing is kept). &why= says what checkApp found. #pair before this browser is paired: nothing was sent or kept.
const $ = id => document.getElementById(id);
const megabytes = bytes => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const WHY = {
  impostor: "Something other than SuperBookmarks is answering at the app address",
  unknown: "SuperBookmarks doesn't know this browser any more",
};
const NEXT = {
  impostor: "Check the app address in the extension's options, then click the button again.",
  unknown: "Enter a new pairing code in the extension's options, then click the button again.",
};

async function show() {
  const hash = new URLSearchParams(location.hash.slice(1));
  const why = hash.get("why");
  if (hash.has("pair")) {
    $("heading").textContent = "Not connected yet";
    $("what").textContent = "This browser isn't connected to SuperBookmarks yet, so nothing was saved and nothing was sent.";
    $("more").textContent = "In SuperBookmarks, open Settings → Sources → Save from your browser and show a pairing code. "
      + "Enter it in the extension's options, then click the button again.";
    $("options").hidden = false;
    return;
  }
  if (hash.has("list")) {
    $("heading").textContent = WHY[why] ?? "SuperBookmarks isn't running";
    $("what").textContent = NEXT[why] ?? "Start SuperBookmarks, then click the button again to list the posts on this page.";
    $("more").textContent = "Nothing was kept: you choose the posts in the Save window.";
    return;
  }
  const { queue } = await chrome.storage.local.get("queue");
  const items = Array.isArray(queue) ? queue : [];
  const bytes = items.flatMap(item => item.files || []).filter(f => !f.dropped).reduce((sum, f) => sum + f.size, 0);
  const name = (hash.get("kept") || "This page").slice(0, 120);
  $("what").replaceChildren();
  const strong = document.createElement("b");
  strong.textContent = WHY[why] ?? "SuperBookmarks isn't running";
  $("what").append(strong, `, so ${name} waits here, in the extension.`);
  $("more").textContent = `${items.length} waiting${bytes ? ` (${megabytes(bytes)})` : ""}. They go to SuperBookmarks the next time you click the `
    + "button with the app running; you choose there what to keep. Videos and pictures can take up to 200 MB here; past that "
    + "the oldest videos are left out (their posts stay), and you'll be told which.";
}

$("options").addEventListener("click", () => { void chrome.runtime.openOptionsPage().finally(() => window.close()); });
$("close").addEventListener("click", () => window.close());
void show();
