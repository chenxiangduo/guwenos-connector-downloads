import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const outputDir = process.env.CIO_E2E_OUTPUT ?? 'artifacts/macos-user-flow';
const projectDir = process.env.CIO_E2E_PROJECT ?? `${process.env.HOME}/Documents/cio-macos-synthetic-project`;

async function readCookies() {
  const text = await readFile(process.env.CIO_COOKIE_FILE, 'utf8');
  const cookies = [];
  for (const line of text.split(/\r?\n/u)) {
    if (!line || line.startsWith('#')) continue;
    const fields = line.split('\t');
    if (fields.length < 7) continue;
    const [domain, , path, secure, , name, value] = fields;
    cookies.push({ domain, path, secure: secure === 'TRUE', name, value });
  }
  return cookies;
}

async function approvePairing() {
  const result = await execFileAsync('osascript', ['-e', `
tell application "System Events"
  repeat 90
    repeat with p in (every process)
      if (count of windows of p) > 0 then
        tell p
          if name of window 1 is "顾问 OS · 本机连接确认" then
            set frontmost to true
            if exists button "确认连接" of window 1 then
              click button "确认连接" of window 1
            else
              keystroke return
            end if
            return true
          end if
        end tell
      end if
    end repeat
    delay 1
  end repeat
  return false
end tell
`], { timeout: 100_000 });
  if (result.stdout.trim() !== 'true') throw new Error(`Native pairing confirmation was not clicked: ${result.stdout} ${result.stderr}`);
  return result;
}

async function captureNativePairing() {
  await execFileAsync('screencapture', ['-x', `${outputDir}/native-pairing.png`]).catch(error => ({ error }));
  const ui = await execFileAsync('osascript', ['-e', `
tell application "System Events"
  set inventory to {}
  repeat with p in (every process)
    try
      if (count of windows of p) > 0 then set end of inventory to {name of p, name of every window of p}
    end try
  end repeat
  return inventory
end tell
`]).catch(error => ({ error: String(error), stdout: error.stdout, stderr: error.stderr }));
  console.log('MACOS_NATIVE_PAIRING_UI', JSON.stringify(ui));
}

async function chooseProjectFolder() {
  async function clickNativeButton(name) {
    const result = await execFileAsync('osascript', ['-e', `
tell application "System Events"
  repeat with p in (every process)
    repeat with w in (every window of p)
      if name of w is "选择授权目录" then
        set frontmost of p to true
        set buttonPosition to position of button "${name}" of w
        set buttonSize to size of button "${name}" of w
        set x to (item 1 of buttonPosition) + (item 1 of buttonSize) / 2
        set y to (item 2 of buttonPosition) + (item 2 of buttonSize) / 2
        return (x as text) & "," & (y as text)
      end if
    end repeat
  end repeat
end tell
`]);
    const [x, y] = result.stdout.trim().split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`Cannot locate native button ${name}: ${result.stdout}`);
    await execFileAsync('cliclick', [`c:${x},${y}`]);
  }
  await new Promise(resolve => setTimeout(resolve, 3000));
  await clickNativeButton('New Folder');
  await new Promise(resolve => setTimeout(resolve, 500));
  await execFileAsync('cliclick', ['t:cio-macos-synthetic-project']);
  await execFileAsync('cliclick', ['kp:return']);
  await new Promise(resolve => setTimeout(resolve, 1000));
  await clickNativeButton('Choose');
}

async function captureNativeFolder() {
  await execFileAsync('screencapture', ['-x', `${outputDir}/native-folder.png`]).catch(error => ({ error }));
  const ui = await execFileAsync('osascript', ['-e', `
tell application "System Events"
  if exists process "osascript" then
    tell process "osascript"
      set frontmost to true
      return {name of windows, name of every UI element of front window}
    end tell
  end if
end tell
`]).catch(error => ({ error: String(error), stdout: error.stdout, stderr: error.stderr }));
  console.log('MACOS_NATIVE_FOLDER_UI', JSON.stringify(ui));
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  const shellHealth = await execFileAsync('curl', ['-sS', '-i', 'http://127.0.0.1:48121/health']).catch(error => ({ message: error.message, stdout: error.stdout, stderr: error.stderr }));
  console.log('MACOS_SHELL_HEALTH', JSON.stringify(shellHealth));
  const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-proxy-server'] });
  console.log('MACOS_BROWSER_VERSION', browser.version());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  if (process.env.CIO_E2E_PATCH_WEB_CLOCK === '1') {
    await page.route('**/connector-client.mjs', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const body = source.replace('timestamp<header.iat||timestamp>=header.exp', 'timestamp<header.iat-30||timestamp>=header.exp+30');
      if (body === source) throw new Error('Web clock patch did not match connector-client.mjs');
      await route.fulfill({ response, body });
    });
    console.log('MACOS_WEB_CLOCK_PATCH_APPLIED_FOR_CANDIDATE_ONLY');
  }
  await context.grantPermissions(['local-network-access'], { origin: 'https://guwenos.cn' });
  console.log('MACOS_LOOPBACK_PERMISSION_GRANTED');
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => console.log('MACOS_CONSOLE', message.type(), message.text()));
  page.on('requestfailed', request => console.log('MACOS_REQUEST_FAILED', request.url(), request.failure()?.errorText));
  page.on('response', async response => {
    if (!response.url().startsWith('http://127.0.0.1:')) return;
    if (response.status() < 400 && !response.url().includes('/v1/pairings')) return;
    const body = await response.text().catch(error => `<unavailable: ${error}>`);
    console.log('MACOS_LOCAL_RESPONSE', response.request().method(), response.url(), response.status(), body);
  });
  try {
    await page.goto('https://guwenos.cn/login/', { waitUntil: 'domcontentloaded' });
    await page.locator('#demo-submit').click();
    await page.waitForURL(url => url.pathname === '/');
    const sessionDebug = await page.evaluate(async () => {
      const response = await fetch('/api/v1/me');
      return { status: response.status, body: await response.text(), cookies: document.cookie, serverDate: response.headers.get('date'), browserNow: new Date().toISOString() };
    });
    console.log('MACOS_SESSION_DEBUG', JSON.stringify(sessionDebug));
    console.log('MACOS_STAGE browser health probe');
    const healthDebug = await page.evaluate(async () => {
      try {
        const response = await fetch('http://127.0.0.1:48121/health', { targetAddressSpace: 'loopback', signal: AbortSignal.timeout(10_000) });
        return { status: response.status, body: await response.text(), allowOrigin: response.headers.get('access-control-allow-origin'), allowPrivateNetwork: response.headers.get('access-control-allow-private-network') };
      } catch (error) { return { error: String(error) }; }
    });
    console.log('MACOS_HEALTH_DEBUG', JSON.stringify(healthDebug));
    await page.getByText('macOS Connector 已就绪', { exact: true }).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => !document.getElementById('mac-connect-button')?.disabled, { timeout: 30_000 });
    await page.screenshot({ path: `${outputDir}/01-download-ready.png`, fullPage: true });

    console.log('MACOS_STAGE pairing');
    const approval = approvePairing().catch(error => ({ error }));
    await page.getByRole('button', { name: '已安装，连接本机' }).click();
    await page.waitForTimeout(12_000);
    await captureNativePairing();
    console.log('MACOS_PAIRING_UI', JSON.stringify(await page.evaluate(() => ({
      notice: document.getElementById('notice')?.textContent,
      step: document.getElementById('connector-step')?.textContent,
      message: document.getElementById('connector-message-text')?.textContent,
    }))));
    await page.locator('#connector-step').filter({ hasText: '本机已配对' }).waitFor({ timeout: 120_000 });
    const approvalResult = await approval;
    if (approvalResult?.error) throw approvalResult.error;

    console.log('MACOS_STAGE project selection');
    const chooser = chooseProjectFolder().catch(error => ({ error }));
    await page.locator('#select-project-button').click();
    await page.waitForTimeout(12_000);
    await captureNativeFolder();
    await page.locator('#current-project-name').filter({ hasText: 'cio-macos-synthetic-project' }).waitFor({ timeout: 120_000 });
    const chooserResult = await chooser;
    if (chooserResult?.error) throw chooserResult.error;
    await writeFile(`${projectDir}/合成项目说明.txt`, '这是仅用于 macOS 全流程验收的合成项目资料。\n');

    console.log('MACOS_STAGE project activation');
    await page.locator('#activate-project-button').click();
    await page.locator('#workbench-step').filter({ hasText: '可以进入' }).waitFor({ timeout: 60_000 });
    await page.screenshot({ path: `${outputDir}/02-project-activated.png`, fullPage: true });

    console.log('MACOS_STAGE workbench');
    const popupPromise = context.waitForEvent('page', { timeout: 60_000 });
    await page.locator('#enter-workbench').click();
    const workbench = await popupPromise;
    await workbench.waitForLoadState('domcontentloaded');
    await workbench.getByText('顾问工作台', { exact: false }).first().waitFor({ timeout: 60_000 });
    if (!workbench.url().includes('/consultant/')) throw new Error(`Unexpected workbench URL: ${workbench.url()}`);
    await workbench.screenshot({ path: `${outputDir}/03-workbench.png`, fullPage: true });
    if (errors.length) throw new Error(errors.join('; '));
    console.log(`MACOS_USER_FLOW_PASS: download, install, auto-start, browser recognition, pairing, project selection, activation, workbench; evidence=${outputDir}`);
  } catch (error) {
    await page.screenshot({ path: `${outputDir}/failure.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close();
  }
}

await main();
