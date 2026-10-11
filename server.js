// Confession booth server: serves the booth page, hands out questions,
// and writes the uploaded video chunks + session metadata to disk.
// Zero dependencies, so it runs anywhere Node 20+ is installed.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const QUESTIONS_PATH = path.join(ROOT, 'questions.txt');

const DEFAULTS = {
  birthdayName: 'the birthday person',
  questionsPerSession: 5,
  maxSecondsPerQuestion: 90,
  countdownSeconds: 3,
  thankYouSeconds: 10,
  videoBitsPerSecond: 2_500_000,
  cameraName: '',
  microphoneName: '',
  host: '127.0.0.1',
  port: 3000,
  recordingsDir: 'recordings',
};

const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const END_REASONS = new Set(['next', 'timer', 'escape']);
const SESSION_STATUSES = new Set(['completed', 'ended-early']);
// tagline is last so rows still line up with an index.csv started before it existed.
const CSV_COLUMNS = ['session_folder', 'name', 'question_number', 'question', 'file', 'duration_sec', 'ended_by', 'recorded_at', 'tagline'];

const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// --- Config & questions (re-read per session so they can be edited mid-weekend) ---

let config = DEFAULTS;

function loadConfig() {
  try {
    config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch (err) {
    console.error(`config.json could not be read, keeping the previous settings: ${err.message}`);
  }
  return config;
}

function clientSettings(cfg) {
  const {
    birthdayName, questionsPerSession, maxSecondsPerQuestion, countdownSeconds, thankYouSeconds,
    videoBitsPerSecond, cameraName, microphoneName,
  } = cfg;
  return {
    birthdayName, questionsPerSession, maxSecondsPerQuestion, countdownSeconds, thankYouSeconds,
    videoBitsPerSecond, cameraName, microphoneName,
  };
}

function readQuestions(birthdayName) {
  return fs.readFileSync(QUESTIONS_PATH, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((question) => question.replaceAll('{birthday}', birthdayName));
}

function pickRandom(items, count) {
  const pool = [...items];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

// --- Naming helpers ---

function slugify(text, maxLength = 40) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}

function localStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_` +
    `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

function extensionFor(mimeType) {
  if (/^video\/mp4\b/.test(mimeType)) return 'mp4';
  if (/^video\/webm\b/.test(mimeType)) return 'webm';
  if (/^video\/x-matroska\b/.test(mimeType)) return 'mkv';
  return null;
}

// --- Sessions ---

const sessions = new Map(); // sessionId -> { dir, dirName, data, chunkSeq, queue }
let indexQueue = Promise.resolve();

// Every disk write for a session goes through its queue, so chunk appends and
// session.json rewrites never interleave.
function enqueue(session, task) {
  const run = session.queue.then(task);
  session.queue = run.catch(() => {});
  return run;
}

async function writeSessionFile(session) {
  const target = path.join(session.dir, 'session.json');
  await fsp.writeFile(`${target}.tmp`, JSON.stringify(session.data, null, 2));
  await fsp.rename(`${target}.tmp`, target);
}

async function createSessionDir(recordingsDir, name) {
  const base = `${localStamp()}_${slugify(name) || 'anonymous'}`;
  for (let attempt = 1; ; attempt++) {
    const dirName = attempt === 1 ? base : `${base}-${attempt}`;
    const dir = path.join(recordingsDir, dirName);
    try {
      await fsp.mkdir(dir);
      return { dir, dirName };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

function csvField(value) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function appendToIndex(recordingsDir, session) {
  const rows = session.data.clips
    .filter((clip) => clip.file)
    .map((clip) => [
      session.dirName, session.data.name, clip.index, clip.question, `${session.dirName}/${clip.file}`,
      clip.durationSec, clip.endedBy, clip.startedAt, session.data.tagline,
    ].map(csvField).join(','));
  if (rows.length === 0) return Promise.resolve();

  const indexPath = path.join(recordingsDir, 'index.csv');
  indexQueue = indexQueue.then(async () => {
    // The BOM makes Excel open the file as UTF-8, so accented names survive.
    const header = fs.existsSync(indexPath) ? '' : `\uFEFF${CSV_COLUMNS.join(',')}\n`;
    await fsp.appendFile(indexPath, `${header}${rows.join('\n')}\n`);
  }).catch((err) => console.error(`Could not update index.csv: ${err.message}`));
  return indexQueue;
}

function getSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) throw new HttpError(404, 'Unknown or finished session');
  return session;
}

function getClipIndex(session, raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > session.data.clips.length) throw new HttpError(404, 'Unknown clip');
  return n - 1;
}

function parseTimestamp(value, field) {
  const time = Date.parse(value);
  if (typeof value !== 'string' || Number.isNaN(time)) throw new HttpError(400, `${field} must be an ISO timestamp`);
  return time;
}

// --- HTTP plumbing ---

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  try {
    return JSON.parse((await readBody(req, MAX_JSON_BYTES)).toString('utf8'));
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Body must be valid JSON');
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(req, res, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, 'Bad path');
  }
  if (relative.endsWith('/')) relative += 'index.html';
  const filePath = path.join(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Not found');

  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile()) throw new HttpError(404, 'Not found');

  res.writeHead(200, {
    'Content-Type': STATIC_TYPES[path.extname(filePath)] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

// --- API ---

async function handleApi(req, res, parts, url, recordingsDir) {
  const [resource, sessionId, sub, clipNumber, action] = parts;

  // GET /api/settings
  if (req.method === 'GET' && resource === 'settings' && parts.length === 1) {
    return sendJson(res, 200, clientSettings(loadConfig()));
  }

  if (req.method !== 'POST' || resource !== 'session') throw new HttpError(404, 'Not found');

  // POST /api/session  { name, tagline? }
  if (parts.length === 1) {
    const { name: rawName, tagline: rawTagline } = await readJson(req);
    const name = String(rawName ?? '').trim().slice(0, 80);
    if (!name) throw new HttpError(400, 'Name is required');
    const tagline = String(rawTagline ?? '').trim().slice(0, 80);

    const cfg = loadConfig();
    const questions = pickRandom(readQuestions(cfg.birthdayName), cfg.questionsPerSession);
    if (questions.length === 0) throw new HttpError(500, 'questions.txt has no questions');

    const { dir, dirName } = await createSessionDir(recordingsDir, name);
    const session = {
      dir,
      dirName,
      chunkSeq: questions.map(() => 0),
      queue: Promise.resolve(),
      data: {
        name,
        tagline,
        startedAt: new Date().toISOString(),
        endedAt: null,
        status: 'in-progress',
        mimeType: null,
        clips: questions.map((question, i) => ({
          index: i + 1, question, file: null, startedAt: null, endedAt: null, durationSec: null, endedBy: null,
        })),
      },
    };
    const id = crypto.randomUUID();
    sessions.set(id, session);
    await enqueue(session, () => writeSessionFile(session));
    console.log(`Session started: ${name} -> ${dirName}`);
    return sendJson(res, 201, { sessionId: id, questions, settings: clientSettings(cfg) });
  }

  const session = getSession(sessionId);

  // POST /api/session/:id/end  { status }
  if (parts.length === 3 && sub === 'end') {
    const { status } = await readJson(req);
    if (!SESSION_STATUSES.has(status)) throw new HttpError(400, 'Unknown status');
    await enqueue(session, async () => {
      session.data.endedAt = new Date().toISOString();
      session.data.status = status;
      await writeSessionFile(session);
    });
    await appendToIndex(recordingsDir, session);
    sessions.delete(sessionId);
    const recorded = session.data.clips.filter((clip) => clip.file).length;
    console.log(`Session ${status}: ${session.data.name} (${recorded} clip${recorded === 1 ? '' : 's'})`);
    return sendJson(res, 200, { ok: true });
  }

  if (parts.length !== 5 || sub !== 'clip') throw new HttpError(404, 'Not found');
  const clipIndex = getClipIndex(session, clipNumber);
  const clip = session.data.clips[clipIndex];

  // POST /api/session/:id/clip/:n/chunk?seq=K   (raw video bytes)
  // seq makes retries safe: a chunk that was already written is acknowledged, not appended twice.
  if (action === 'chunk') {
    const mimeType = String(req.headers['content-type'] ?? '');
    const ext = extensionFor(mimeType);
    if (!ext) throw new HttpError(415, 'Unsupported video type');
    const seq = Number(url.searchParams.get('seq'));
    if (!Number.isInteger(seq) || seq < 0) throw new HttpError(400, 'seq must be a non-negative integer');

    const body = await readBody(req, MAX_CHUNK_BYTES);
    await enqueue(session, async () => {
      const expected = session.chunkSeq[clipIndex];
      if (seq < expected) return;
      if (seq > expected) throw new HttpError(409, `Expected chunk ${expected}, got ${seq}`);
      if (!clip.file) {
        clip.file = `${String(clip.index).padStart(2, '0')}-${slugify(clip.question) || 'question'}.${ext}`;
        session.data.mimeType ??= mimeType;
        await writeSessionFile(session);
      }
      await fsp.appendFile(path.join(session.dir, clip.file), body);
      session.chunkSeq[clipIndex] = expected + 1;
    });
    res.writeHead(204).end();
    return;
  }

  // POST /api/session/:id/clip/:n/end  { startedAt, endedAt, endedBy }
  if (action === 'end') {
    const { startedAt, endedAt, endedBy } = await readJson(req);
    const start = parseTimestamp(startedAt, 'startedAt');
    const end = parseTimestamp(endedAt, 'endedAt');
    if (!END_REASONS.has(endedBy)) throw new HttpError(400, 'Unknown endedBy');
    await enqueue(session, async () => {
      Object.assign(clip, {
        startedAt: new Date(start).toISOString(),
        endedAt: new Date(end).toISOString(),
        durationSec: Math.round((end - start) / 100) / 10,
        endedBy,
      });
      await writeSessionFile(session);
    });
    return sendJson(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

// --- Start ---

const startupConfig = loadConfig();
const recordingsDir = path.resolve(ROOT, startupConfig.recordingsDir);
fs.mkdirSync(recordingsDir, { recursive: true });

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://booth.local');
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] === 'api') {
      await handleApi(req, res, parts.slice(1), url, recordingsDir);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, url.pathname);
    } else {
      throw new HttpError(405, 'Method not allowed');
    }
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (res.headersSent) return res.destroy();
    sendJson(res, err.status ?? 500, { error: err instanceof HttpError ? err.message : 'Internal server error' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${startupConfig.port} is already in use. Is the booth already running?`);
    process.exit(1);
  }
  throw err;
});

server.listen(startupConfig.port, startupConfig.host, () => {
  console.log(`Confession booth running at http://${startupConfig.host === '0.0.0.0' ? 'localhost' : startupConfig.host}:${startupConfig.port}`);
  console.log(`Recordings are saved to ${recordingsDir}`);
});
