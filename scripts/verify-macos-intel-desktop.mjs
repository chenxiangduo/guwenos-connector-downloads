import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const origin = 'https://guwenos.cn';
const output = resolve(process.env.CIO_E2E_OUTPUT ?? 'artifacts/macos-user-flow');
const sandbox = resolve(process.env.RUNNER_TEMP ?? '/tmp', 'cio-desktop-acceptance');
const expectedFile = 'Consulting-Intelligence-Connector-macOS-x64-1.0.11.zip';
const expectedSha256 = '0067777c6fb668fd18922c2d024962fd3e98c375b14d4bc2b11300144a68e90f';

function note(stage, detail = '') {
  console.log(new Date().toISOString(), stage, detail);
}
async function desktop(name) {
  await exec('/usr/sbin/screencapture', ['-x', join(output, name)], { timeout: 8000 });
}
async function screenshot(name) {
  await desktop(name).catch(error => note('SCREENSHOT_UNAVAILABLE', error.code ?? error.signal));
}
async function health() {
  try {
    const response = await fetch('http://127.0.0.1:48121/health', { signal: AbortSignal.timeout(1500) });
    return (await response.json()).ready === true;
  } catch {
    return false;
  }
}
async function waitUntil(check, timeout, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(1000);
  }
  throw new Error(label);
}

async function clickPairingWhenVisible(code) {
  const script = [
    'on run argv',
    'set expectedCode to item 1 of argv',
    'tell application "System Events"',
    'repeat with p in (every application process whose name is "ConnectorRunner" or name is "applet")',
    'try',
    'repeat with w in windows of p',
    'if name of w is "顾问 OS · 本机连接确认" then',
    'repeat with labelItem in static texts of w',
    'if (value of labelItem as text) contains expectedCode then',
    'if exists button "确认连接" of w then return "ready"',
    'end if',
    'end repeat',
    'end if',
    'end repeat',
    'end try',
    'end repeat',
    'end tell',
    'return "waiting"',
    'end run',
  ].join('\n');
  await waitUntil(async () => {
    const result = await exec('/usr/bin/osascript', ['-e', script, code], { timeout: 6500 }).catch(() => null);
    return result?.stdout.trim() === 'ready';
  }, 100_000, 'Timed out locating a native dialog with the same six-digit pairing code');
  await screenshot('03-pairing-window.png');
  await exec('/usr/bin/osascript', ['-e', [
    'tell application "System Events"',
    'repeat with p in (every application process whose name is "ConnectorRunner" or name is "applet")',
    'repeat with w in windows of p',
    'if name of w is "顾问 OS · 本机连接确认" then',
    'click button "确认连接" of w',
    'return',
    'end if',
    'end repeat',
    'end repeat',
    'end tell',
    'error "Pairing window disappeared"',
  ].join('\n')], { timeout: 8000 });
  note('PAIRING_DIALOG_CONFIRMED');
}

async function selectFolder() {
  const script = [
    'tell application "System Events"',
    'repeat with p in (every application process whose name is "ConnectorRunner" or name is "applet")',
    'try',
    'repeat with w in windows of p',
    'if name of w is "Choose a Folder" or name of w is "选择授权目录" then',
    'set frontmost of p to true',
    'return true',
    'end if',
    'end repeat',
    'end try',
    'end repeat',
    'end tell',
    'return false',
  ].join('\n');
  await waitUntil(async () => {
    const result = await exec('/usr/bin/osascript', ['-e', script], { timeout: 6000 }).catch(() => null);
    return result?.stdout.trim() === 'true';
  }, 65_000, 'Timed out opening the native folder picker');
  await screenshot('04-folder-picker.png');
  const project = join(sandbox, 'cio-intel-desktop-project');
  await exec('/usr/bin/osascript', ['-e', 'tell application "System Events" to keystroke "g" using {command down, shift down}'], { timeout: 5000 });
  await exec('cliclick', ['w:700', 't:' + project, 'kp:return', 'w:1800', 'kp:return'], { timeout: 12000 });
}

async function bounded(promise, ms, name) {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(ms, null, { signal: timer.signal }).then(() => { throw new Error(name + ' timed out'); }),
    ]);
  } finally {
    timer.abort();
  }
}

await mkdir(output, { recursive: true });
await mkdir(sandbox, { recursive: true });
const project = join(sandbox, 'cio-intel-desktop-project');
await mkdir(project, { recursive: true });
await writeFile(join(project, '合成项目说明.txt'), '仅用于 macOS 26 Intel 桌面验收的合成资料。\n');
if (await health()) throw new Error('Test machine already has an active Connector');

let context;
let page;
try {
note('HEADFUL_CHROME_STARTING');
context = await chromium.launchPersistentContext(join(sandbox, 'chrome-profile'), { channel: 'chrome', headless: false, acceptDownloads: true, viewport: { width: 1440, height: 900 }, args: ['--no-proxy-server'], timeout: 25_000 });
note('HEADFUL_CHROME_CONTEXT_READY');
page = context.pages()[0] ?? await bounded(context.newPage(), 15_000, 'Opening Chrome tab');
page.setDefaultTimeout(20_000);
page.setDefaultNavigationTimeout(30_000);
note('HEADFUL_CHROME_TAB_READY');
await bounded(context.grantPermissions(['local-network-access'], { origin }), 8000, 'Granting browser test permission');
note('BROWSER_LOCAL_NETWORK_PERMISSION_PREGRANTED');
page.on('response', async response => {
  if (!response.url().startsWith('http://127.0.0.1:') || !response.url().includes('/v1/pairings')) return;
  const snapshot = await response.json().catch(() => ({}));
  note('PAIRING_HTTP', [response.request().method(), response.status(), snapshot.status ?? '', snapshot.errorCode ?? ''].join(' '));
});

  note('PRODUCTION_LOGIN_NAVIGATION');
  await page.goto(origin + '/login/', { waitUntil: 'domcontentloaded' });
  await page.locator('#demo-submit').click();
  await page.waitForURL(url => url.pathname === '/', { waitUntil: 'domcontentloaded' });
  note('PRODUCTION_HOME_DOM_READY');
  await screenshot('01-production-home.png');
  const downloadLink = page.getByRole('link', { name: '下载 Intel Mac' });
  const targetUrl = new URL(await downloadLink.getAttribute('href'), origin);
  if (targetUrl.origin !== origin || !targetUrl.pathname.endsWith('/' + expectedFile)) {
    throw new Error('Production download version differs from the expected checked package');
  }
  await screenshot('01-download-entry.png');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 90_000 }), downloadLink.click()]);
  const zip = join(sandbox, expectedFile);
  await bounded(download.saveAs(zip), 90_000, 'Saving browser download');
  const hash = createHash('sha256').update(await readFile(zip)).digest('hex');
  if (hash !== expectedSha256) throw new Error('Production package SHA-256 mismatch');
  note('OFFICIAL_DOWNLOAD_HASH_VERIFIED', hash);

  const getQuarantine = path => exec('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path], { timeout: 8000 }).then(() => true, () => false);
  note('ZIP_QUARANTINE_PRESENT', await getQuarantine(zip));
  await exec('/usr/bin/ditto', ['-x', '-k', zip, sandbox], { timeout: 60_000 });
  const installer = join(sandbox, 'connector', 'Install.command');
  note('INSTALLER_QUARANTINE_PRESENT', await getQuarantine(installer));
  await exec('/usr/bin/open', [installer], { timeout: 20_000 });
  note('INSTALLER_OPEN_REQUESTED');
  await delay(3500);
  await screenshot('02-install-desktop.png');
  await waitUntil(health, 60_000, 'GUI installer did not start a ready Connector within 60 seconds');
  note('INSTALL_AND_AUTOSTART_READY');

  await bounded(page.bringToFront(), 8000, 'Focusing Chrome after install');
  await page.getByRole('button', { name: '已安装，连接本机' }).click();
  const statusLine = page.locator('#connector-message-text');
  await statusLine.filter({ hasText: /校验码.*\d{6}/ }).waitFor({ timeout: 30_000 });
  const code = (await statusLine.textContent()).match(/\d{6}/)?.[0];
  if (!code) throw new Error('Browser did not present a pairing code');
  note('BROWSER_RECOGNIZED_AND_PAIRING_REQUESTED');
  await clickPairingWhenVisible(code);
  await page.locator('#connector-step').filter({ hasText: '本机已配对' }).waitFor({ timeout: 30_000 });
  note('BROWSER_PAIRED');

  await bounded(page.bringToFront(), 8000, 'Focusing Chrome to select project');
  await page.locator('#select-project-button').click();
  await selectFolder();
  await page.locator('#current-project-name').filter({ hasText: 'cio-intel-desktop-project' }).waitFor({ timeout: 45_000 });
  await bounded(page.bringToFront(), 8000, 'Focusing Chrome to activate project');
  await page.locator('#activate-project-button').click();
  await page.locator('#workbench-step').filter({ hasText: '可以进入' }).waitFor({ timeout: 60_000 });
  await screenshot('05-project-activated.png');

  const [workbench] = await Promise.all([context.waitForEvent('page', { timeout: 45_000 }), page.locator('#enter-workbench').click()]);
  await workbench.getByText('顾问工作台', { exact: false }).first().waitFor({ timeout: 60_000 });
  if (new URL(workbench.url()).pathname !== '/consultant/') throw new Error('Unexpected workbench path');
  await screenshot('06-workbench.png');
  note('INTEL_PRODUCTION_DESKTOP_FLOW_PASSED');
} catch (error) {
  process.exitCode = 1;
  note('DESKTOP_FLOW_FAILED', error.message);
  await screenshot('failure-desktop.png');
  const state = page ? await bounded(page.locator('#connector-message-text').textContent({ timeout: 2000 }), 3000, 'Reading browser status').catch(() => '') : '';
  note('VISIBLE_CONNECTOR_STATUS', state?.replace(/\b\d{6}\b/g, '[code]') ?? '');
  if (page) await bounded(page.screenshot({ path: join(output, 'failure-browser.png'), timeout: 5000 }), 7000, 'Capturing browser').catch(() => {});
  throw error;
} finally {
  if (context) await bounded(context.close(), 5000, 'Closing Chrome').catch(error => {
    note('CLEANUP_FAILED', error.message);
    process.exit(process.exitCode ?? 0);
  });
}
