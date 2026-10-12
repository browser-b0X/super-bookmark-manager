// Settings > Sources has one import field (v0.3.0): every bookmark export goes through
// "Choose a file to import", a preview, then "Import N new links". Suites that used the
// old direct-import buttons call this instead. `preview` is the preview's text (its counts
// and the "In the file: … left out" line that the old messages carried), '' when refused.
export async function importThroughField(page, file, { duplicates = true, choose } = {}) {
  const preview = page.getByLabel('Import preview');
  const status = page.getByRole('status', { name: 'Import result', exact: true });
  // `choose` lets a suite pick the file another way (e.g. the keyboard file chooser).
  await (choose ? choose() : page.getByLabel('Choose a file to import').setInputFiles(file));
  await preview.or(status).first().waitFor();
  if (!(await preview.count())) return { added: 0, updated: 0, text: (await status.innerText()).trim(), refused: true, preview: '' };
  const extra = preview.getByRole('checkbox', { name: /Also import the \d+ likely duplicates/ });
  if (duplicates && await extra.count()) await extra.check();
  const previewText = (await preview.innerText()).trim();
  const go = preview.getByRole('button', { name: /^Import \d+ new links?$/ });
  if (await go.isDisabled()) {
    await preview.getByRole('button', { name: 'Cancel', exact: true }).click();
    return { added: 0, updated: 0, text: 'nothing to import', refused: false, preview: previewText };
  }
  await go.click();
  await status.waitFor();
  const text = (await status.innerText()).trim();
  return { added: Number(/(\d+) new links? imported/.exec(text)?.[1] ?? 0), updated: Number(/(\d+) already saved/.exec(text)?.[1] ?? 0), text, refused: false, preview: previewText };
}
