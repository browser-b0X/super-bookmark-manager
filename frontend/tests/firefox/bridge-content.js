// Test-only: on the Firefox pass's control page, passes the harness's commands to the add-on's background.
// "contentFetch" runs here instead, to see how a content script's fetch of a picture server behaves.
window.addEventListener("message", event => {
  if (event.source !== window || !event.data || typeof event.data.ffpassCmd !== "string") return;
  const { id, ffpassCmd, url, value } = event.data;
  const reply = result => window.postMessage({ ffpassResult: id, result: JSON.stringify(result === undefined ? null : result) }, "*");
  if (ffpassCmd === "postBlob") {
    // What handover.js does: a file made here, posted to the page.
    const bytes = new Uint8Array(1000);
    bytes.set([1, 2, 3]);
    window.postMessage({ type: "probe-blob", blob: new Blob([bytes], { type: "video/mp4" }), size: 1000 }, location.origin);
    reply(true);
    return;
  }
  if (ffpassCmd === "contentFetch") {
    (async () => {
      const steps = [];
      try {
        const response = await fetch(url, { credentials: "omit", cache: "force-cache", referrerPolicy: "strict-origin-when-cross-origin" });
        steps.push(`status ${response.status} ok ${response.ok} length ${response.headers.get("content-length")}`);
        try {
          const reader = response.clone().body.getReader();
          const { value: first } = await reader.read();
          steps.push(`stream read ${first ? first.length : 0} bytes`);
        } catch (error) { steps.push(`stream failed: ${error}`); }
        try {
          // Exactly media.js's way: every piece, then one Blob.
          const reader = response.clone().body.getReader();
          const parts = [];
          for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); }
          steps.push(`pieces ${parts.length}`);
          const whole = new Blob(parts, { type: "video/mp4" });
          steps.push(`whole ${whole.size} bytes`);
          const sliced = new Uint8Array(await whole.slice(0, 16).arrayBuffer());
          steps.push(`slice ${sliced.length}`);
          steps.push(`btoa ${btoa(String.fromCharCode.apply(null, sliced)).length}`);
        } catch (error) { steps.push(`media.js way failed: ${error}`); }
        try { const blob = await response.blob(); steps.push(`blob ${blob.size} bytes`); } catch (error) { steps.push(`blob failed: ${error}`); }
      } catch (error) { steps.push(`fetch failed: ${error}`); }
      reply(steps);
    })();
    return;
  }
  browser.runtime.sendMessage({ ffpass: true, cmd: ffpassCmd, url, value }).then(reply, error => reply({ error: String(error) }));
});
