// A small WebDriver BiDi client for Firefox: start the system Firefox on a throwaway profile, connect, send
// commands, wait for events. Nothing here touches the owner's own Firefox profile.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const FIREFOX = 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';

/** prefs: extra user.js lines as { name: value }. Returns { send, on, close, profile }. */
export async function launch(prefs = {}, { headless = true } = {}) {
  const profile = await mkdtemp(join(tmpdir(), 'sbm-ff-profile-'));
  const lines = Object.entries({
    'browser.shell.checkDefaultBrowser': false, 'browser.startup.homepage_override.mstone': 'ignore',
    'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.reportingpolicy.firstRun': false,
    'app.update.disabledForTesting': true, 'browser.aboutwelcome.enabled': false, ...prefs,
  }).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`);
  await writeFile(join(profile, 'user.js'), lines.join('\n') + '\n');
  const args = ['-profile', profile, '-no-remote', '--remote-debugging-port', '0', ...(headless ? ['-headless'] : []), 'about:blank'];
  const ff = spawn(FIREFOX, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const address = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Firefox did not start BiDi: ' + log.slice(-800))), 60000);
    const read = chunk => {
      log += chunk;
      const m = /WebDriver BiDi listening on (ws:\/\/[^\s]+)/.exec(log);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    };
    ff.stdout.on('data', read);
    ff.stderr.on('data', read);
    ff.on('exit', code => reject(new Error(`Firefox exited (${code}): ${log.slice(-800)}`)));
  });
  const socket = new WebSocket(address.replace(/\/$/, '') + '/session');
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 1;
  const pending = new Map();
  const listeners = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.type === 'error') reject(new Error(`${message.error}: ${message.message}`)); else resolve(message.result);
    } else if (message.type === 'event') {
      for (const listener of listeners) listener(message);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const on = listener => { listeners.push(listener); return () => listeners.splice(listeners.indexOf(listener), 1); };
  const close = async () => {
    try { await send('browser.close'); } catch { /* already gone */ }
    socket.close();
    await new Promise(resolve => { if (ff.exitCode !== null) resolve(); else { ff.on('exit', resolve); setTimeout(() => { ff.kill(); resolve(); }, 8000); } });
  };
  return { send, on, close, profile, log: () => log };
}

/** Evaluate an expression in a browsing context; returns the plain value (strings, numbers, booleans, null, JSON). */
export async function evaluate(bidi, context, expression) {
  const result = await bidi.send('script.evaluate', { expression: `(async () => JSON.stringify(await (${expression})))()`,
    target: { context }, awaitPromise: true, resultOwnership: 'none' });
  if (result.type === 'exception') throw new Error('page exception: ' + JSON.stringify(result.exceptionDetails).slice(0, 600));
  const value = result.result.value;
  return value === undefined ? undefined : JSON.parse(value);
}
