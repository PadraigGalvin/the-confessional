// Renders the compilation's graphics (name tags, question cards, titles) as PNGs.
// It loads graphics.html in headless Chrome and screenshots it, so the graphics
// use the booth's own stylesheet and fonts and look exactly like the booth did.
// Talks to Chrome over the DevTools protocol with Node's built-in WebSocket, so
// there's nothing to install.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findBrowser } from './find-browser.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const GRAPHICS_PAGE = path.join(HERE, '..', 'graphics', 'graphics.html');
const START_TIMEOUT_MS = 20000;

export async function openGraphics({ width, height, profileDir }) {
  if (typeof WebSocket === 'undefined') {
    throw new Error(`Drawing the graphics needs Node.js 22 or newer (this is ${process.version}). Install it from https://nodejs.org`);
  }
  const browserPath = findBrowser();
  if (!browserPath) {
    throw new Error('Could not find Google Chrome, Chromium or Microsoft Edge to draw the graphics. Install one, or set BOOTH_BROWSER to its path.');
  }
  fs.mkdirSync(profileDir, { recursive: true });
  const browser = spawn(browserPath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--allow-file-access-from-files', // the page loads the booth stylesheet, fonts and stills from disk
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });

  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`The browser did not start:\n${output}`)), START_TIMEOUT_MS);
    browser.on('error', (err) => reject(new Error(`Could not start the browser: ${err.message}`)));
    browser.stderr.on('data', (data) => {
      output += data;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
  });

  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('Could not connect to the browser')), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  const eventWaiters = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      const call = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) call?.reject(new Error(`${call.method}: ${message.error.message}`));
      else call?.resolve(message.result);
      return;
    }
    for (const waiter of eventWaiters.filter((w) => w.method === message.method)) {
      eventWaiters.splice(eventWaiters.indexOf(waiter), 1);
      waiter.resolve(message.params);
    }
  });

  let sessionId;
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { method, resolve, reject });
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });
  const nextEvent = (method) => new Promise((resolve) => eventWaiters.push({ method, resolve }));

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
  await send('Page.enable');
  const loaded = nextEvent('Page.loadEventFired');
  await send('Page.navigate', { url: pathToFileURL(GRAPHICS_PAGE).href });
  await loaded;

  return {
    // spec is passed to render() in graphics.html; images in it are file:// URLs.
    async render(spec, outputPath) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', {
        expression: `render(${JSON.stringify(spec)})`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (exceptionDetails) {
        throw new Error(`Could not draw the ${spec.type} graphic: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`);
      }
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(outputPath, Buffer.from(data, 'base64'));
      return result.value;
    },
    close() {
      socket.close();
      browser.kill();
    },
  };
}
