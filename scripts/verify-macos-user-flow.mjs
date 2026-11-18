import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const outputDir = process.env.CIO_E2E_OUTPUT ?? 'artifacts/macos-user-flow';
const projectDir = process.env.CIO_E2E_PROJECT ?? '/tmp/cio-macos-synthetic-project';

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
  return execFileAsync('osascript', ['-e', `
tell application "System Events"
  repeat 90
    if exists process "osascript" then
      tell process "osascript" to set frontmost to true
      delay 0.5
      keystroke return
      exit repeat
    end if
    delay 1
  end repeat
end tell
`], { timeout: 100_000 });
}

async function chooseProjectFolder() {
  return execFileAsync('osascript', ['-e', `
tell application "System Events"
  repeat 90
    if exists process "osascript" then
      tell process "osascript" to set frontmost to true
      delay 0.5
      keystroke "g" using {command down, shift down}
      delay 0.5
      keystroke "${projectDir}"
      delay 0.5
      keystroke return
      delay 0.5
      keystroke return
      exit repeat
    end if
    delay 1
  end repeat
end tell
`], { timeout: 100_000 });
}

async function main() {
  await mkdir(outputDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });
  await writeFile(`${projectDir}/合成项目说明.txt`, '这是仅用于 macOS 全流程验收的合成项目资料。\n');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addCookies(await readCookies());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto('https://guwenos.cn/', { waitUntil: 'domcontentloaded' });
    await page.getByText('macOS Connector 已就绪', { exact: true }).waitFor({ timeout: 30_000 });
    await page.screenshot({ path: `${outputDir}/01-download-ready.png`, fullPage: true });

    const approval = approvePairing().catch(error => ({ error }));
    await page.getByRole('button', { name: '已安装，连接本机' }).click();
    await page.locator('#connector-step').filter({ hasText: '本机已配对' }).waitFor({ timeout: 120_000 });
    const approvalResult = await approval;
    if (approvalResult?.error) throw approvalResult.error;

    const chooser = chooseProjectFolder().catch(error => ({ error }));
    await page.locator('#select-project-button').click();
    await page.locator('#current-project-name').filter({ hasText: 'cio-macos-synthetic-project' }).waitFor({ timeout: 120_000 });
    const chooserResult = await chooser;
    if (chooserResult?.error) throw chooserResult.error;

    await page.locator('#activate-project-button').click();
    await page.locator('#workbench-step').filter({ hasText: '可以进入' }).waitFor({ timeout: 60_000 });
    await page.screenshot({ path: `${outputDir}/02-project-activated.png`, fullPage: true });

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
