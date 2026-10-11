// Starts the booth server and opens Chrome (or Edge) full-screen in kiosk mode,
// using a dedicated browser profile that auto-allows the camera and microphone.
// The server is restarted if it crashes. Closing the browser (Alt+F4) stops everything.
// Set BOOTH_BROWSER to a browser executable to override auto-detection.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = path.join(ROOT, '.booth-browser-profile');
const SERVER_RESTART_MS = 2000;
const SERVER_START_TIMEOUT_MS = 15000;

const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const host = !config.host || config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
const url = `http://${host}:${config.port ?? 3000}/`;

function findOnPath(command) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findBrowser() {
  if (process.env.BOOTH_BROWSER) return process.env.BOOTH_BROWSER;
  const { PROGRAMFILES, LOCALAPPDATA } = process.env;
  const programFilesX86 = process.env['PROGRAMFILES(X86)'];
  const candidates = {
    win32: [
      PROGRAMFILES && path.join(PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      programFilesX86 && path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      LOCALAPPDATA && path.join(LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      programFilesX86 && path.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      PROGRAMFILES && path.join(PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ],
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  }[process.platform] ?? ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'].map(findOnPath);
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

async function serverIsUp() {
  try {
    return (await fetch(`${url}api/settings`)).ok;
  } catch {
    return false;
  }
}

let server = null;
let browser = null;
let shuttingDown = false;

function startServer() {
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, stdio: 'inherit' });
  server.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`Server stopped (${signal ?? `exit code ${code}`}). Restarting in ${SERVER_RESTART_MS / 1000} seconds...`);
    setTimeout(startServer, SERVER_RESTART_MS);
  });
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  browser?.kill();
  server?.kill();
  process.exit(exitCode);
}

if (await serverIsUp()) {
  console.error(`Something is already running at ${url}. Stop it first (or close the other booth window).`);
  process.exit(1);
}

const browserPath = findBrowser();
if (!browserPath) {
  console.error('Could not find Google Chrome, Chromium or Microsoft Edge. Install one, or set BOOTH_BROWSER to its path.');
  process.exit(1);
}

startServer();
const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
while (!(await serverIsUp())) {
  if (Date.now() > deadline) {
    console.error('The booth server did not start. See the errors above.');
    shutdown(1);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}

console.log(`Opening ${url} in kiosk mode with ${browserPath}`);
console.log('Press Alt+F4 in the booth window to close it and stop the booth.');
browser = spawn(browserPath, [
  '--kiosk',
  `--user-data-dir=${PROFILE_DIR}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--use-fake-ui-for-media-stream', // auto-allow camera + mic (only in this dedicated profile)
  '--autoplay-policy=no-user-gesture-required',
  '--noerrdialogs',
  '--disable-session-crashed-bubble',
  '--disable-infobars',
  '--disable-features=Translate',
  '--disable-pinch',
  '--overscroll-history-navigation=0',
  url,
], { stdio: 'ignore' });
browser.on('error', (err) => {
  console.error(`Could not open the browser: ${err.message}`);
  shutdown(1);
});
browser.on('exit', () => shutdown());

process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
