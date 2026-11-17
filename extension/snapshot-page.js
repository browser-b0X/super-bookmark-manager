// Shows the page structure the right-click menu just copied (snapshot.js), once: it leaves the extension's storage
// as soon as it is shown.
const $ = id => document.getElementById(id);

async function show() {
  const { snapshot } = await chrome.storage.local.get("snapshot");
  await chrome.storage.local.remove("snapshot");
  $("text").value = typeof snapshot === "string" && snapshot ? snapshot : "Nothing to show: copy a page's structure from its right-click menu.";
}

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("text").value);
    $("status").textContent = "Copied. Paste it where you were asked for it.";
    $("status").className = "status ok";
  } catch {
    $("text").select();
    $("status").textContent = "Your browser didn't allow copying: the text is selected, so press Ctrl+C.";
    $("status").className = "status warn";
  }
});
$("close").addEventListener("click", () => window.close());
void show();
