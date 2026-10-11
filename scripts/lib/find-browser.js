// Finds Google Chrome, Chromium or Microsoft Edge for this platform.
// Set BOOTH_BROWSER to a browser executable to override auto-detection.

import fs from 'node:fs';
import path from 'node:path';

function findOnPath(command) {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function findBrowser() {
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
