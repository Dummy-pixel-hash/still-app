// Smoke-test only Still's debug WebView on one explicitly selected device.
// Example: node scripts/android/smoke.mjs --serial SERIAL --credentials
// The optional credential probe uses a temporary non-SSH value and removes it.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const option = name => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const serial = option('--serial');
if (!serial || serial.startsWith('--')) throw new Error('Pass --serial with the exact attached adb device ID.');
const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
const platformAdb = sdk && join(sdk, 'platform-tools', process.platform === 'win32' ? 'adb.exe' : 'adb');
const executable = process.env.ADB || (platformAdb && existsSync(platformAdb) ? platformAdb : 'adb');
const adb = (...args) => execFileSync(executable, ['-s', serial, ...args], { encoding: 'utf8', timeout: 30000 }).trim();
const output = option('--screenshots');
const results = [];
let socket, port, sequence = 0;
const pending = new Map();
const report = (name, data = {}) => { results.push({ name, pass: true, ...data }); };
function check(value, message) { if (!value) throw new Error(message); }
async function attach() {
  const pid = adb('shell', 'pidof', 'dev.still.app').split(' ')[0];
  check(pid && /^\d+$/.test(pid), 'Still is not running.');
  port = adb('forward', 'tcp:0', `localabstract:webview_devtools_remote_${pid}`);
  // A restarted Activity can be reported as drawn before its debug socket/page
  // is ready. Bound this startup readiness wait instead of assuming immediate CDP.
  let page;
  for (let attempt = 0; attempt < 40 && !page; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      page = pages.find(value => value.url === 'http://tauri.localhost/' || value.url.startsWith('http://tauri.localhost/?'));
    } catch { /* WebView has not published its page yet. */ }
    if (!page) await new Promise(resolve => setTimeout(resolve, 250));
  }
  check(page, 'Still debug WebView is unavailable; use a debug APK with embedded assets.');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => {
    const value = JSON.parse(event.data);
    if (!value.id || !pending.has(value.id)) return;
    const task = pending.get(value.id); pending.delete(value.id); clearTimeout(task.timer);
    if (value.error) task.reject(new Error(JSON.stringify(value.error)));
    else task.resolve(value.result);
  });
}
function command(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 20000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ': ' + (result.exceptionDetails.exception?.description || 'WebView exception'));
  return result.result?.value;
}
async function waitFor(condition) {
  for (let contextAttempt = 0; contextAttempt < 12; contextAttempt++) {
    try { return await evaluate(`(async()=>{for(let attempt=0;attempt<120;attempt++){if(${condition})return true;await new Promise(resolve=>setTimeout(resolve,100))}throw new Error('Mobile state did not appear')})()`); }
    catch (error) {
      // A read-only readiness query is safe to repeat across a startup document
      // replacement. Never retry mutating/native operations automatically.
      if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
  throw new Error('Still WebView kept replacing its startup document.');
}
async function click(selector) {
  await evaluate(`(()=>{const button=document.querySelector(${JSON.stringify(selector)});if(!button)throw Error('Control not found');button.click()})()`);
}
async function screenshot(name) {
  if (!output) return;
  const capture = await command('Page.captureScreenshot', { format: 'png' });
  mkdirSync(output, { recursive: true }); writeFileSync(join(output, name + '.png'), Buffer.from(capture.data, 'base64'));
}
async function detach() {
  socket?.close(); socket = undefined;
  if (port) { try { adb('forward', '--remove', `tcp:${port}`); } catch {} port = undefined; }
}

let probeId;
try {
  await attach();
  await waitFor('!!document.querySelector("[data-mobile-shell]") && !!document.querySelector(".mobile-heading h1")');
  await click('.mobile-navigation [aria-label="Agents"]');
  await waitFor(`document.querySelector('.mobile-heading h1')?.textContent === 'Threads'`);
  await evaluate('document.fonts.ready.then(()=>true)');
  const layout = await evaluate(`({title:document.querySelector('.mobile-heading h1').textContent,windowControls:document.querySelectorAll('[aria-label="Minimize"],[aria-label="Maximize or restore"]').length,width:innerWidth,pageWidth:document.documentElement.scrollWidth,displayFont:document.fonts.check('16px "Still Display"'),bodyFont:document.fonts.check('16px "Still Source"')})`);
  check(layout.title === 'Threads' && layout.windowControls === 0, 'Android is displaying the desktop shell.');
  check(layout.pageWidth <= layout.width && layout.displayFont && layout.bodyFont, 'Mobile layout/fonts did not load.');
  report('native Android Threads entry and fonts', layout);
  const ping = await evaluate(`window.__TAURI_INTERNALS__.invoke('still_ping')`);
  check(ping.app === 'still-app', 'Native IPC is unavailable.'); report('real native IPC');
  await screenshot('threads');

  for (const destination of ['terminals', 'settings', 'agents']) {
    await click(`.mobile-navigation [aria-label="${destination === 'agents' ? 'Agents' : destination === 'terminals' ? 'Terminals' : 'Settings'}"]`);
    await waitFor(`document.querySelector('.mobile-heading h1')?.textContent === ${JSON.stringify(destination === 'agents' ? 'Threads' : destination === 'terminals' ? 'Terminals' : 'Settings')}`);
  }
  report('three native mobile root destinations');
  await click('.mobile-navigation [aria-label="Settings"]');
  adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  await waitFor(`document.querySelector('.mobile-heading h1')?.textContent === 'Threads'`);
  report('Android system Back returns from Settings to Threads');

  await click('.mobile-new-task');
  await waitFor(`!!document.querySelector('.agent-workspace--mobile textarea')`);
  check(await evaluate(`!document.querySelector('.agent-sidebar') && !!document.querySelector('.mobile-agent-header')`), 'Desktop navigation is still present in mobile detail.');
  await screenshot('new-task');
  await click('[aria-label="Back to threads"]');
  await waitFor(`!document.querySelector('.agent-workspace--mobile')`);
  report('mobile task detail and return without desktop chrome');

  if (argv.includes('--credentials')) {
    probeId = `__android_build_probe_${randomUUID()}`;
    const args = JSON.stringify({ keyId: probeId });
    await evaluate(`window.__TAURI_INTERNALS__.invoke('still_save_key',{args:${args},secret:'temporary-probe-not-an-ssh-key'})`);
    check(await evaluate(`window.__TAURI_INTERNALS__.invoke('still_has_key',{args:${args}})`), 'Native credential store did not retain the temporary value.');
    await detach();
    adb('shell', 'am', 'force-stop', 'dev.still.app');
    adb('shell', 'am', 'start', '-W', '-n', 'dev.still.app/.MainActivity');
    await attach(); await waitFor(`!!document.querySelector('[data-mobile-shell]')`);
    check(await evaluate(`window.__TAURI_INTERNALS__.invoke('still_has_key',{args:${args}})`), 'Keystore-backed credential did not survive process restart.');
    await evaluate(`window.__TAURI_INTERNALS__.invoke('still_forget_key',{args:${args}})`);
    check(!(await evaluate(`window.__TAURI_INTERNALS__.invoke('still_has_key',{args:${args}})`)), 'Temporary credential was not removed.');
    probeId = undefined; report('Keystore save/read across process restart and delete');
  }
  console.log(JSON.stringify({ device: adb('shell', 'getprop', 'ro.product.model'), android: adb('shell', 'getprop', 'ro.build.version.release'), results }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ completedChecks: results.map(value => value.name), error: error.message }, null, 2));
  process.exitCode = 1;
} finally {
  if (probeId && !socket) { try { await attach(); } catch {} }
  if (probeId && socket) { try { await evaluate(`window.__TAURI_INTERNALS__.invoke('still_forget_key',{args:${JSON.stringify({ keyId: probeId })}})`); } catch {} }
  await detach();
  for (const task of pending.values()) clearTimeout(task.timer);
}
