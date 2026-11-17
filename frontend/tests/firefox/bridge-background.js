// Test-only, added to the Firefox pass's copy of the add-on: lets the harness do what a click on the toolbar
// button or the options page would (Firefox's WebDriver BiDi can't open the add-on's own pages).
const transferLog = [];
try {
  const realSend = chrome.tabs.sendMessage.bind(chrome.tabs);
  chrome.tabs.sendMessage = (...args) => realSend(...args).then(answer => answer, error => { transferLog.push(`sendMessage(${args[1] && args[1].type}): ${error}`); throw error; });
  const realExec = chrome.scripting.executeScript.bind(chrome.scripting);
  chrome.scripting.executeScript = (...args) => realExec(...args).then(answers => {
    if (args[0].func && String(args[0].func).includes("chunk")) transferLog.push(`chunk: ${typeof (answers[0] && answers[0].result)} ${answers[0] && answers[0].error}`);
    return answers;
  }, error => { transferLog.push(`executeScript: ${error}`); throw error; });
  transferLog.push("instrumented");
} catch (error) { transferLog.push(`could not instrument: ${error}`); }
browser.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.ffpass !== true || !sender.tab) return undefined;
  return (async () => {
    switch (message.cmd) {
      case "set": await browser.storage.local.set(message.value); return true;
      case "saveFromTab": {
        const tab = (await browser.tabs.query({})).find(t => t.url === message.url);
        if (!tab) return { error: "no such tab" };
        await sbm.saveFromTab({ id: tab.id, url: tab.url, title: tab.title });
        return true;
      }
      case "syncMarks": await sbm.syncMarks(); return true;
      case "badge": return [await browser.action.getBadgeText({}), await browser.action.getTitle({})];
      case "checkApp": { const s = await sbm.settings(); return checkApp(s.app, s.connId, s.token); }
      case "registered": return (await browser.scripting.getRegisteredContentScripts()).map(s => s.id);
      case "openOptions": await browser.runtime.openOptionsPage(); return true;
      case "transferLog": return transferLog.slice(-20);
      case "extensionTabs": return (await browser.tabs.query({})).map(t => t.url).filter(u => u && u.startsWith(browser.runtime.getURL("")));
      case "mediaProbe": {
        // Exactly what background.js does with media.js, with everything reported.
        const tab = (await browser.tabs.query({})).find(t => t.url === message.url);
        if (!tab) return { error: "no such tab" };
        const out = {};
        try { await browser.scripting.executeScript({ target: { tabId: tab.id }, files: ["media.js"] }); out.injected = true; }
        catch (error) { out.inject = String(error); return out; }
        try {
          const answers = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: list => globalThis.sbmMedia.fetchAll(list), args: [message.value] });
          out.answers = answers.map(a => ({ keys: Object.keys(a), result: a.result, error: a.error ? String(a.error) : undefined }));
        } catch (error) { out.call = String(error); }
        return out;
      }
      default: return { error: "unknown command" };
    }
  })().catch(error => ({ error: String(error && error.message || error) }));
});
