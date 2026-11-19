import { chromium } from 'playwright';
import pngjs from 'pngjs';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const origin = 'https://guwenos.cn';
const output = resolve(process.env.CIO_E2E_OUTPUT ?? 'artifacts/macos-user-flow');
const sandbox = resolve(process.env.RUNNER_TEMP ?? '/tmp', 'cio-desktop-acceptance');
const expectedFile = 'Consulting-Intelligence-Connector-macOS-x64-1.0.11.zip';
const expectedSha256 = '0067777c6fb668fd18922c2d024962fd3e98c375b14d4bc2b11300144a68e90f';
const nativeChrome = process.env.CIO_DESKTOP_NATIVE_CHROME === '1';
const browserDownload = nativeChrome && process.env.CIO_DESKTOP_COMPARE_HTTP_TRANSFER !== '1';
let passwordEntryVerified = true;

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

async function clickSystemButton(apps, names) {
  const script = [
    'on run argv',
    'set appNames to paragraphs of item 1 of argv',
    'set buttonNames to paragraphs of item 2 of argv',
    'tell application "System Events"',
    'repeat with processName in appNames',
    'try',
    'repeat with appWindow in windows of application process (contents of processName)',
    'repeat with element in entire contents of appWindow',
    'try',
    'if role of element is "AXButton" and buttonNames contains (name of element as text) then',
    'click element',
    'return true',
    'end if',
    'end try',
    'end repeat',
    'end repeat',
    'end try',
    'end repeat',
    'end tell',
    'return false',
    'end run',
  ].join('\n');
  const result = await exec('/usr/bin/osascript', ['-e', script, apps.join('\n'), names.join('\n')], { timeout: 9000 });
  return result.stdout.trim() === 'true';
}

async function vmAuthorizationDialogVisible(screenshotName) {
  const filename = join(output, screenshotName);
  const { width, height, data } = pngjs.PNG.sync.read(await readFile(filename));
  if (width !== 1920 || height !== 1080) return false;
  // The padlock is invariant when the OK button changes appearance during input.
  const markers = [[880, 230, 252, 195, 105], [870, 260, 228, 155, 53]];
  return markers.every(([x, y, ...rgb]) => {
    const offset = (y * width + x) * 4;
    return rgb.every((value, index) => Math.abs(data[offset + index] - value) < 8);
  });
}

async function provisionTestAdministrator() {
  const password = process.env.CIO_TEST_VM_ADMIN_PASSWORD;
  if (!password || !/^[a-f0-9]{20}$/u.test(password)) throw new Error('Disposable VM administrator was not provisioned');
  if (process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('This credential comparison requires a disposable GitHub VM');
  const user = 'cioinstallqa';
  await exec('/usr/bin/sudo', ['-n', '/usr/sbin/sysadminctl', '-addUser', user, '-fullName', 'Connector VM Test Administrator', '-password', password, '-admin'], { timeout: 18_000 }).catch(() => {
    throw new Error('Creating the disposable VM administrator failed');
  });
  const administrator = await exec('/usr/sbin/dseditgroup', ['-o', 'checkmember', '-m', user, 'admin'], { timeout: 5000 });
  if (!administrator.stdout.startsWith('yes')) throw new Error('The disposable VM test account is not an administrator');
  await exec('/usr/bin/dscl', ['.', '-authonly', user, password], { timeout: 7000 }).catch(() => {
    throw new Error('The test administrator did not authenticate against the VM user directory');
  });
  note('GATEKEEPER_VM_ADMIN_PROVISIONED');
  const loginProgram = join(sandbox, 'verify-admin-login.exp');
  await writeFile(loginProgram, `
log_user 0
set timeout 35
set secret $env(CIO_TEST_VM_ADMIN_PASSWORD)
unset env(CIO_TEST_VM_ADMIN_PASSWORD)
spawn /usr/bin/su -l cioinstallqa
expect {
  -re {(?i)password:} { send -- "$secret\\r" }
  timeout { puts stderr "Login did not show a password prompt"; exit 21 }
  eof { exit 22 }
}
unset secret
expect {
  -re {(?i)login incorrect} { exit 23 }
  -re {[%#$] ?$} { send -- "/usr/bin/id -un\\r" }
  timeout { exit 24 }
  eof { exit 25 }
}
expect {
  -re {\\r\\ncioinstallqa\\r\\n} { send -- "exit\\r" }
  timeout { exit 26 }
  eof { exit 27 }
}
expect eof
`, { mode: 0o600 });
  try {
    await exec('/usr/bin/expect', [loginProgram], { timeout: 85_000 });
    note('MACOS_PASSWORD_LOGIN_SHELL_CONFIRMED', user);
  } catch (error) {
    note('MACOS_PASSWORD_LOGIN_UNCONFIRMED', error.code ?? error.signal);
  }
}

async function pressAuthorizationButton() {
  const executable = join(sandbox, 'window-owners');
  const source = join(sandbox, 'window-owners.m');
  await writeFile(source, `
#import <Foundation/Foundation.h>
#import <CoreGraphics/CoreGraphics.h>
int main(void) {
  @autoreleasepool {
    NSArray *windows = CFBridgingRelease(CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID));
    NSMutableArray *owners = [NSMutableArray array];
    for (NSDictionary *window in windows) {
      NSDictionary *bounds = window[(__bridge NSString *)kCGWindowBounds];
      CGRect rect;
      if (CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)bounds, &rect) && CGRectContainsPoint(rect, CGPointMake(960, 347))) {
        [owners addObject:@[window[(__bridge NSString *)kCGWindowOwnerPID] ?: @0, window[(__bridge NSString *)kCGWindowOwnerName] ?: @"", window[(__bridge NSString *)kCGWindowLayer] ?: @0, bounds]];
      }
      if ([owners count] == 10) break;
    }
    NSData *json = [NSJSONSerialization dataWithJSONObject:owners options:0 error:nil];
    if (!json) return 1;
    fwrite([json bytes], 1, [json length], stdout);
  }
  return 0;
}
`);
  await exec('/usr/bin/clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'CoreGraphics', source, '-o', executable], { timeout: 45_000 });
  const inventory = await exec(executable, [], { timeout: 6000 });
  const windows = JSON.parse(inventory.stdout);
  await writeFile(join(output, 'authorization-window-owners.txt'), JSON.stringify(windows, null, 2));
  const panel = windows.find(([, , , bounds]) => bounds.Width >= 200 && bounds.Width <= 400 && bounds.Height >= 270 && bounds.Height <= 450);
  if (!panel) return null;
  const [pid, owner] = panel;
  note('AUTHORIZATION_WINDOW_OWNER', owner);
  const script = [
    'on run argv',
    'set uiSummary to ""',
    'tell application "System Events"',
    'set identity to item 1 of argv as integer',
    'try',
    'set candidate to first application process whose unix id is identity',
    'set uiSummary to "owner windows=" & (count of windows of candidate) & linefeed',
    'repeat with promptRef in windows of candidate',
    'set promptWindow to contents of promptRef',
    'set potentialControls to (buttons of promptWindow) & (entire contents of promptWindow)',
    'repeat with controlRef in potentialControls',
    'try',
    'set controlElement to contents of controlRef',
    'set controlRole to get role of controlElement',
    'if controlRole is "AXButton" then',
    'set controlTitle to get name of controlElement',
    'set uiSummary to uiSummary & "button=" & controlTitle & linefeed',
    'if controlTitle is "OK" then',
    'perform action "AXPress" of controlElement',
    'return "PRESSED"',
    'end if',
    'end if',
    'end try',
    'end repeat',
    'end repeat',
    'on error eventMessage number eventNumber',
    'set uiSummary to uiSummary & "AX query error " & eventNumber & linefeed',
    'end try',
    'end tell',
    'return uiSummary',
    'end run',
  ].join('\n');
  const result = await exec('/usr/bin/osascript', ['-e', script, String(pid)], { timeout: 12_000 });
  await writeFile(join(output, 'authorization-accessibility.txt'), result.stdout);
  return result.stdout.trim() === 'PRESSED' ? { pid, owner } : null;
}

async function typeInSystemDialog(commands) {
  const input = spawn('/usr/bin/osascript', ['-'], { stdio: ['pipe', 'ignore', 'ignore'], timeout: 9000 });
  const done = new Promise((resolve, reject) => {
    input.on('error', reject);
    input.on('close', code => code === 0 ? resolve() : reject(new Error('Sending the disposable VM credentials failed')));
  });
  input.stdin.end(['tell application "System Events"', ...commands, 'end tell'].join('\n'));
  await done;
}

function passwordFieldFocused({ width, height, data }) {
  if (width !== 1920 || height !== 1080) return false;
  const color = (x, y) => data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3);
  const focusBlue = (x, y) => {
    const [red, green, blue] = color(x, y);
    return red < 140 && green > 140 && green < 205 && blue > 225;
  };
  return focusBlue(844, 467) && focusBlue(900, 455) && !focusBlue(950, 424);
}

function countPasswordBullets({ width, data }) {
  let previousDark = false;
  let bullets = 0;
  for (let x = 848; x <= 1060; x++) {
    const offset = (469 * width + x) * 4;
    const dark = data[offset] < 65 && data[offset + 1] < 65 && data[offset + 2] < 65;
    if (dark && !previousDark) bullets++;
    previousDark = dark;
  }
  return bullets;
}

async function authenticateTestAdministrator() {
  if (!await vmAuthorizationDialogVisible('02c-gatekeeper-after-confirmation.png')) return;
  const password = process.env.CIO_TEST_VM_ADMIN_PASSWORD;
  await exec('cliclick', ['c:938,437'], { timeout: 5000 });
  await typeInSystemDialog([
    'keystroke "a" using command down',
    'keystroke "cioinstallqa"',
    'key code 48',
  ]);
  await delay(350);
  await desktop('02-auth-password-focus.png');
  const focus = pngjs.PNG.sync.read(await readFile(join(output, '02-auth-password-focus.png')));
  if (!passwordFieldFocused(focus)) throw new Error('The secure password field did not receive focus');
  passwordEntryVerified = false;
  await typeInSystemDialog([
    'repeat with letter in characters of ' + JSON.stringify(password),
    'keystroke (contents of letter)',
    'delay 0.06',
    'end repeat',
  ]);
  const privateScreenshot = join(sandbox, 'auth-input-private.png');
  await exec('/usr/sbin/screencapture', ['-x', privateScreenshot], { timeout: 8000 });
  const privateFrame = pngjs.PNG.sync.read(await readFile(privateScreenshot));
  await unlink(privateScreenshot);
  if (!passwordFieldFocused(privateFrame) || countPasswordBullets(privateFrame) !== password.length) {
    throw new Error('The system dialog did not show all password characters in the secure field');
  }
  passwordEntryVerified = true;
  note('GATEKEEPER_PASSWORD_FIELD_VERIFIED');
  const approval = await pressAuthorizationButton().catch(error => {
    note('AUTHORIZATION_ACCESSIBILITY_FAILED', String(error.stderr || error.signal || error.code));
    return null;
  });
  note('AUTHORIZATION_ACCESSIBILITY_PRESSED', Boolean(approval));
  if (!approval) await exec('cliclick', ['c:1018,512'], { timeout: 5000 });
  await delay(2000);
  await screenshot('02d-gatekeeper-auth-result.png');
  if (!await vmAuthorizationDialogVisible('02d-gatekeeper-auth-result.png')) return;
  if (approval?.owner === 'coreautha') {
    await exec('/usr/bin/sudo', ['-n', '/usr/bin/sample', String(approval.pid), '4', '-file', join(output, 'coreautha-sample.txt')], { timeout: 12000 }).catch(() => {});
  }
  await waitUntil(async () => {
    if (await health()) return true;
    await desktop('02e-gatekeeper-auth-recheck.png');
    return !await vmAuthorizationDialogVisible('02e-gatekeeper-auth-recheck.png');
  }, 50_000, 'macOS did not dismiss the authorization prompt within 50 seconds after submission with a verified VM administrator');
  note('GATEKEEPER_AUTHORIZATION_PROMPT_CLOSED');
}

async function captureAuthorizationDiagnostics() {
  const predicate = '(process BEGINSWITH "coreauth" OR ((process == "authd" OR process BEGINSWITH "SecurityAgent" OR process == "syspolicyd") AND (eventMessage CONTAINS[c] "authoriz" OR eventMessage CONTAINS[c] "denied" OR eventMessage CONTAINS[c] "override" OR eventMessage CONTAINS[c] "credential" OR eventMessage CONTAINS[c] "failed" OR eventMessage CONTAINS[c] "interaction")))';
  const result = await exec('/usr/bin/sudo', ['-n', '/usr/bin/log', 'show', '--last', '2m', '--info', '--style', 'compact', '--predicate', predicate], { timeout: 18_000, maxBuffer: 512 * 1024 });
  const password = process.env.CIO_TEST_VM_ADMIN_PASSWORD;
  const safe = password ? result.stdout.replaceAll(password, '[redacted]') : result.stdout;
  await writeFile(join(output, 'macos-authorization-log.txt'), safe.split('\n').slice(-100).join('\n'));
}

async function openVerifiedInstaller(installer) {
  const open = exec('/usr/bin/open', [installer], { timeout: 15_000 }).catch(error => note('INSTALLER_OPEN_RESULT', error.signal ?? error.code));
  note('INSTALLER_OPEN_REQUESTED');
  await delay(6000);
  await screenshot('02-install-desktop.png');
  if (browserDownload && !await health()) {
    const gatekeeperApps = ['CoreServicesUIAgent', 'SecurityAgent', 'syspolicyd'];
    const dismiss = await clickSystemButton(gatekeeperApps, ['Done']).catch(() => false);
    if (!dismiss) {
      const dimensions = await exec('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(output, '02-install-desktop.png')], { timeout: 5000 });
      if (!/pixelWidth: 1920\s+pixelHeight: 1080/u.test(dimensions.stdout)) throw new Error('Unexpected desktop size for verified Gatekeeper dialog');
      await exec('cliclick', ['c:960,454'], { timeout: 5000 });
      await delay(700);
      await screenshot('02-dismissed-gatekeeper.png');
    }
    note('GATEKEEPER_FIRST_DIALOG_DISMISSED', dismiss);
    await exec('/usr/bin/open', ['x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Security'], { timeout: 12_000 });
    await delay(2500);
    await screenshot('02a-privacy-and-security.png');
    const settingsConfirmed = await clickSystemButton(['System Settings'], ['Open Anyway']).catch(() => false);
    if (!settingsConfirmed) {
      await delay(5500);
      await screenshot('02a-privacy-and-security-ready.png');
      const dimensions = await exec('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(output, '02a-privacy-and-security-ready.png')], { timeout: 5000 });
      if (!/pixelWidth: 1920\s+pixelHeight: 1080/u.test(dimensions.stdout)) throw new Error('Unexpected desktop size for Privacy & Security');
      await exec('cliclick', ['c:1238,616'], { timeout: 5000 });
    }
    note('GATEKEEPER_OPEN_ANYWAY_PRESSED');
    await delay(2000);
    await screenshot('02b-gatekeeper-confirmation.png');
    await provisionTestAdministrator();
    const finalConfirmed = await clickSystemButton(gatekeeperApps, ['Open Anyway', 'Open']).catch(() => false);
    if (!finalConfirmed) {
      const dimensions = await exec('/usr/bin/sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', join(output, '02b-gatekeeper-confirmation.png')], { timeout: 5000 });
      if (!/pixelWidth: 1920\s+pixelHeight: 1080/u.test(dimensions.stdout)) throw new Error('Unexpected desktop size for Gatekeeper confirmation');
      await exec('cliclick', ['c:960,470'], { timeout: 5000 });
    }
    await delay(1500);
    await screenshot('02c-gatekeeper-after-confirmation.png');
    if (!await health()) await authenticateTestAdministrator();
  }
  await open;
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

let browser;
let context;
let page;
try {
note(nativeChrome ? 'HEADFUL_CHROME_STARTING' : 'HEADLESS_BROWSER_STARTING_WITH_NATIVE_DESKTOP');
const browserOptions = { channel: nativeChrome ? 'chrome' : 'chromium', headless: !nativeChrome, chromiumSandbox: true, args: ['--no-proxy-server'], timeout: 55_000 };
const contextOptions = { acceptDownloads: true, viewport: { width: 1440, height: 900 } };
if (nativeChrome) {
  context = await chromium.launchPersistentContext(join(sandbox, 'chrome-profile'), { ...browserOptions, ...contextOptions, downloadsPath: sandbox });
  page = context.pages()[0];
} else {
  browser = await chromium.launch(browserOptions);
  context = await bounded(browser.newContext(contextOptions), 15_000, 'Creating browser context');
}
page ??= await bounded(context.newPage(), 15_000, 'Opening browser tab');
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
  const downloadLink = page.getByRole('link', { name: '下载 Intel Mac' });
  const targetUrl = new URL(await downloadLink.getAttribute('href'), origin);
  if (targetUrl.origin !== origin || !targetUrl.pathname.endsWith('/' + expectedFile)) {
    throw new Error('Production download version differs from the expected checked package');
  }
  await page.screenshot({ path: join(output, '01-download-entry.png'), timeout: 12_000 });
  const zip = join(sandbox, expectedFile);
  if (browserDownload) {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 50_000 }), downloadLink.click()]);
    const chromiumFile = await bounded(download.path(), 80_000, 'Completing Chrome download');
    await rename(chromiumFile, zip);
  } else {
    const cookies = await context.cookies(targetUrl.href);
    if (!cookies.length) throw new Error('Production login did not provide a download session');
    const cookieJar = join(sandbox, 'download-session.cookies');
    const cookieRows = cookies.map(cookie => [cookie.domain, cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE', cookie.path,
      cookie.secure ? 'TRUE' : 'FALSE', Math.max(0, Math.floor(cookie.expires)), cookie.name, cookie.value].join('\t'));
    await writeFile(cookieJar, '# Netscape HTTP Cookie File\n' + cookieRows.join('\n') + '\n', { mode: 0o600, flag: 'wx' });
    try {
      const transfer = await exec('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--connect-timeout', '12', '--max-time', '120', '--cookie', cookieJar, '--output', zip,
        '--write-out', '%{http_code} %{size_download}', targetUrl.href], { timeout: 125_000 });
      note('OFFICIAL_DOWNLOAD_AUTHENTICATED_HTTP', transfer.stdout);
    } finally {
      await unlink(cookieJar);
    }
  }
  const hash = createHash('sha256').update(await readFile(zip)).digest('hex');
  if (hash !== expectedSha256) throw new Error('Production package SHA-256 mismatch');
  note('OFFICIAL_DOWNLOAD_HASH_VERIFIED', hash);

  const getQuarantine = path => exec('/usr/bin/xattr', ['-p', 'com.apple.quarantine', path], { timeout: 8000 }).then(() => true, () => false);
  note('ZIP_QUARANTINE_PRESENT', await getQuarantine(zip));
  await exec('/usr/bin/ditto', ['-x', '-k', zip, sandbox], { timeout: 60_000 });
  const installer = join(sandbox, 'connector', 'Install.command');
  note('INSTALLER_QUARANTINE_PRESENT', await getQuarantine(installer));
  await openVerifiedInstaller(installer);
  await waitUntil(health, 60_000, 'GUI installer did not start a ready Connector within 60 seconds');
  note('INSTALL_AND_AUTOSTART_READY');

  await page.getByText('macOS Connector 已就绪', { exact: true }).waitFor();
  await page.getByRole('button', { name: '已安装，连接本机' }).isEnabled().then(enabled => {
    if (!enabled) throw new Error('The browser did not enable the connection button');
  });
  await page.getByRole('button', { name: '已安装，连接本机' }).click();
  const statusLine = page.locator('#connector-message-text');
  await statusLine.filter({ hasText: /校验码.*\d{6}/ }).waitFor({ timeout: 30_000 });
  const code = (await statusLine.textContent()).match(/\d{6}/)?.[0];
  if (!code) throw new Error('Browser did not present a pairing code');
  note('BROWSER_RECOGNIZED_AND_PAIRING_REQUESTED');
  await clickPairingWhenVisible(code);
  await page.locator('#connector-step').filter({ hasText: /本机已配对|已连接/ }).waitFor({ timeout: 30_000 });
  note('BROWSER_PAIRED');

  await page.locator('#select-project-button').click();
  await selectFolder();
  await page.locator('#current-project-name').filter({ hasText: 'cio-intel-desktop-project' }).waitFor({ timeout: 45_000 });
  await page.locator('#activate-project-button').click();
  await page.locator('#workbench-step').filter({ hasText: '可以进入' }).waitFor({ timeout: 60_000 });
  await page.screenshot({ path: join(output, '05-project-activated.png'), timeout: 12_000 });

  const [workbench] = await Promise.all([context.waitForEvent('page', { timeout: 45_000 }), page.locator('#enter-workbench').click()]);
  await workbench.getByText('顾问工作台', { exact: false }).first().waitFor({ timeout: 60_000 });
  if (new URL(workbench.url()).pathname !== '/consultant/') throw new Error('Unexpected workbench path');
  await workbench.screenshot({ path: join(output, '06-workbench.png'), timeout: 12_000 });
  note('INTEL_PRODUCTION_DESKTOP_FLOW_PASSED');
} catch (error) {
  process.exitCode = 1;
  note('DESKTOP_FLOW_FAILED', error.message);
  if (passwordEntryVerified) await screenshot('failure-desktop.png');
  if (browserDownload) await captureAuthorizationDiagnostics().catch(error => note('AUTH_DIAGNOSTICS_UNAVAILABLE', error.code ?? error.signal));
  const state = page ? await bounded(page.locator('#connector-message-text').textContent({ timeout: 2000 }), 3000, 'Reading browser status').catch(() => '') : '';
  note('VISIBLE_CONNECTOR_STATUS', state?.replace(/\b\d{6}\b/g, '[code]') ?? '');
  if (page) await bounded(page.screenshot({ path: join(output, 'failure-browser.png'), timeout: 5000 }), 7000, 'Capturing browser').catch(() => {});
  throw error;
} finally {
  if (context) await bounded(browser ? browser.close() : context.close(), 5000, 'Closing Chromium').catch(error => {
    note('CLEANUP_FAILED', error.message);
    process.exit(process.exitCode ?? 0);
  });
}
