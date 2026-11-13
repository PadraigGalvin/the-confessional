// Builds the birthday film from the booth's clips.
//
//   npm run compile              The first run writes compilation/running-order.csv.
//                                Number the clips you want in its "order" column, then
//   npm run compile              renders the film to compilation/<name>-the-weekend.mp4.
//   npm run compile -- --all     Uses every clip in spreadsheet order (for a test run).
//
// The film opens with a title sequence over a wall of guests' faces. Each answer gets
// the guest's name tag and the show title, burned in exactly as the booth showed them,
// and a question card plays whenever the question changes. It ends on a "Happy
// birthday" freeze frame and credits listing everyone in the film. Graphics are drawn
// with the booth's own stylesheet (see scripts/graphics/graphics.html), and every
// answer's volume is levelled. Each piece is rendered once and cached in
// compilation/cache, so after changing the order or a trim only the changed pieces
// are redone.
//
// Set FFMPEG / FFPROBE if they aren't on your PATH, and BOOTH_BROWSER to pick the browser.

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatCsv, parseCsv } from './lib/csv.js';
import { GRAPHICS_PAGE, openGraphics } from './lib/graphics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'compilation');
const CACHE_DIR = path.join(OUTPUT_DIR, 'cache');
const RUNNING_ORDER = path.join(OUTPUT_DIR, 'running-order.csv');
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE ?? 'ffprobe';

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
// Bump to re-render every cached piece after changing how they're made.
const RENDER_VERSION = 1;

const SHOW_NAME = 'The Weekend'; // the bug in public/app.js reads "<birthdayName> · The Weekend"
const INTRO_LABEL = 'Confessions from the booth';
const CARD_LABEL = 'We asked';
const CREDITS_LABEL = 'Starring';
const INTRO_SECONDS = 6;
const WRAP_SECONDS = 4.5;
const MAX_MOSAIC_STILLS = 24;
const LOUDNESS = 'I=-16:TP=-1.5:LRA=11';

const DEFAULTS = {
  birthdayName: 'the birthday person',
  recordingsDir: 'recordings',
};
const COMPILATION_DEFAULTS = {
  introVideo: '',
  introMusic: '',
  outroMusic: '',
  outroTitle: 'Happy birthday,\n{birthday}.',
  outroNote: 'Love from everyone who stepped into the booth',
  lowerThirdSeconds: 6,
  normalizeAudio: true,
};

const EDIT_COLUMNS = ['order', 'start', 'end', 'name', 'tagline', 'card'];
const INFO_COLUMNS = ['question', 'duration_sec', 'section', 'recorded_at', 'file'];

class UserError extends Error {}

// --- Small helpers ---

const hash = (value) => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 16);
const toFrames = (seconds) => Math.round(seconds * FPS) / FPS;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const relative = (file) => path.relative(process.cwd(), file) || file;

function slugify(text) {
  return text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Identifies a file's current contents cheaply, so a cache entry is redone if it changes.
function fileIdentity(file) {
  const stat = fs.statSync(file);
  return { file, size: stat.size, modified: stat.mtimeMs };
}

function loadConfig() {
  const config = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')) };
  config.compilation = { ...COMPILATION_DEFAULTS, ...config.compilation };
  return config;
}

// Accepts seconds ("12", "12.5", or "12,5" from a European spreadsheet) or "m:ss".
function parseSeconds(value, column, line) {
  if (!value) return null;
  const parts = value.replace(',', '.').split(':').map(Number);
  if (parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    throw new UserError(`Row ${line}: ${column} "${value}" should be a number of seconds, like 12.5 or 1:05`);
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function dateRange(timestamps) {
  const dates = timestamps.map((t) => new Date(t)).filter((d) => !Number.isNaN(d.getTime())).sort((a, b) => a - b);
  if (dates.length === 0) return '';
  const first = dates[0];
  const last = dates.at(-1);
  const format = (date, options) => date.toLocaleDateString('en-GB', options);
  const full = { day: 'numeric', month: 'long', year: 'numeric' };
  if (first.toDateString() === last.toDateString()) return format(first, full);
  if (first.getMonth() === last.getMonth() && first.getFullYear() === last.getFullYear()) {
    return `${first.getDate()}–${format(last, full)}`;
  }
  if (first.getFullYear() === last.getFullYear()) return `${format(first, { day: 'numeric', month: 'long' })} – ${format(last, full)}`;
  return `${format(first, full)} – ${format(last, full)}`;
}

// --- ffmpeg ---

function run(command, args, what) {
  const result = spawnSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new UserError(`Could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${what} failed:\n${result.stderr.trim().split('\n').slice(-15).join('\n')}`);
  return result;
}

function ffmpeg(args, what) {
  return run(FFMPEG, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], what);
}

function probe(file) {
  const { stdout } = run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file], `Reading ${relative(file)}`);
  const info = JSON.parse(stdout);
  return {
    duration: Number(info.format?.duration) || 0,
    hasAudio: info.streams.some((stream) => stream.codec_type === 'audio'),
  };
}

// Holds a graphic on screen for as long as needed. The image is decoded once,
// which is much quicker than ffmpeg's "-loop 1" re-reading it for every frame.
const HOLD = `loop=loop=-1:size=1,fps=${FPS}`;

// veryfast renders about 2.5 times quicker than medium, with no visible difference
// for upscaled webcam footage at this quality; the files are just a little bigger.
const ENCODE_ARGS = [
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', String(FPS),
  '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2',
  '-movflags', '+faststart',
];

// Writes to a temporary name first, so an interrupted render never looks finished.
function encode(args, output, what) {
  const partial = `${output}.partial.mp4`;
  try {
    ffmpeg([...args, ...ENCODE_ARGS, partial], what);
    fs.renameSync(partial, output);
  } finally {
    fs.rmSync(partial, { force: true });
  }
}

// First pass of two-pass loudness levelling: measure the trimmed clip.
function measureLoudness(input, start, duration) {
  const { stderr } = run(FFMPEG, [
    '-hide_banner', '-nostdin', '-nostats', '-ss', String(start), '-t', String(duration), '-i', input,
    '-vn', '-af', `aresample=async=1,loudnorm=${LOUDNESS}:print_format=json`, '-f', 'null', '-',
  ], `Measuring the volume of ${relative(input)}`);
  try {
    const measured = JSON.parse(stderr.slice(stderr.lastIndexOf('{'), stderr.lastIndexOf('}') + 1));
    if (!Number.isFinite(Number(measured.input_i))) return null; // silent clip
    return `loudnorm=${LOUDNESS}:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}` +
      `:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}` +
      `:offset=${measured.target_offset}:linear=true:print_format=none`;
  } catch {
    return null;
  }
}

function extractStill(input, time, output) {
  ffmpeg(['-ss', String(Math.max(0, time)), '-i', input, '-frames:v', '1', '-q:v', '2', output], `Grabbing a still from ${relative(input)}`);
  if (!fs.existsSync(output)) {
    // Seeking past the last frame gives nothing, so fall back to the end of the clip.
    ffmpeg(['-sseof', '-0.5', '-i', input, '-frames:v', '1', '-q:v', '2', output], `Grabbing a still from ${relative(input)}`);
  }
}

// A clip from the booth (or any video), fitted to the frame, with graphics laid over it.
function renderVideo({ input, start, duration, hasAudio, overlays, levelAudio }, output) {
  const args = ['-ss', String(start), '-t', String(duration), '-i', input];
  for (const overlay of overlays) args.push('-i', overlay.png);
  if (!hasAudio) args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo');

  const filters = [
    `[0:v]fps=${FPS},scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${WIDTH}:${HEIGHT}:-1:-1:color=black,setsar=1,tpad=stop=-1:stop_mode=clone[v0]`,
  ];
  overlays.forEach((overlay, i) => {
    const fades = overlay.showFor
      ? `,fade=t=in:st=0.3:d=0.4:alpha=1,fade=t=out:st=${overlay.showFor}:d=0.5:alpha=1`
      : '';
    filters.push(`[${i + 1}:v]format=rgba,${HOLD}${fades}[o${i}]`, `[v${i}][o${i}]overlay=0:0[v${i + 1}]`);
  });
  filters.push(`[v${overlays.length}]format=yuv420p[v]`);

  const audioIn = hasAudio ? '[0:a]' : `[${overlays.length + 1}:a]`;
  const loudness = hasAudio && levelAudio ? measureLoudness(input, start, duration) : null;
  filters.push(`${audioIn}aresample=async=1:first_pts=0${loudness ? `,${loudness}` : ''},aresample=48000,` +
    `afade=t=in:d=0.05,afade=t=out:st=${Math.max(0, duration - 0.15)}:d=0.15,apad[a]`);

  encode([...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-t', String(duration)], output, `Rendering ${relative(input)}`);
}

// A still graphic held on screen. A second layer can slide in over the first, for the intro.
function renderStill({ layers, duration, fadeIn = 0.3, fadeOut = 0.3, music }, output) {
  const args = layers.flatMap((layer) => ['-i', layer.png]);
  if (music) args.push('-ss', String(music.offset), '-t', String(duration), '-i', music.file);
  else args.push('-f', 'lavfi', '-t', String(duration), '-i', 'anullsrc=r=48000:cl=stereo');

  const filters = [`[0:v]scale=${WIDTH}:${HEIGHT},setsar=1,${HOLD}[v0]`];
  layers.slice(1).forEach((layer, i) => {
    // Slides in from the left with an ease-out, starting 0.4s in.
    filters.push(
      `[${i + 1}:v]format=rgba,${HOLD},fade=t=in:st=0.4:d=0.6:alpha=1[l${i}]`,
      `[v${i}][l${i}]overlay=x='if(lt(t,0.4),-${WIDTH / 12},if(lt(t,1.2),-${WIDTH / 12}*pow(1-(t-0.4)/0.8,3),0))':y=0[v${i + 1}]`,
    );
  });
  const fades = [
    fadeIn > 0 && `fade=t=in:d=${fadeIn}`,
    fadeOut > 0 && `fade=t=out:st=${duration - fadeOut}:d=${fadeOut}`,
  ].filter(Boolean);
  filters.push(`[v${layers.length - 1}]${[...fades, 'format=yuv420p'].join(',')}[v]`);

  const audioIn = `[${layers.length}:a]`;
  if (music) {
    const musicFades = [
      music.fadeIn && `afade=t=in:d=${music.fadeIn}`,
      music.fadeOut && `afade=t=out:st=${duration - music.fadeOut}:d=${music.fadeOut}`,
    ].filter(Boolean);
    filters.push(`${audioIn}aresample=48000,aformat=channel_layouts=stereo${musicFades.map((f) => `,${f}`).join('')},apad[a]`);
  } else {
    filters.push(`${audioIn}anull[a]`);
  }

  encode([...args, '-filter_complex', filters.join(';'), '-map', '[v]', '-map', '[a]', '-t', String(duration)], output, 'Rendering a title card');
}

// --- The running order: the spreadsheet where clips are picked and ordered ---

function readIndex(recordingsDir) {
  const indexPath = path.join(recordingsDir, 'index.csv');
  if (!fs.existsSync(indexPath)) return { columns: [], rows: [] };
  return parseCsv(fs.readFileSync(indexPath, 'utf8'));
}

// Adds any clips recorded since the running order was made, keeping everything already in it.
function updateRunningOrder(index) {
  const exists = fs.existsSync(RUNNING_ORDER);
  const sheet = exists ? parseCsv(fs.readFileSync(RUNNING_ORDER, 'utf8')) : { columns: [], rows: [], delimiter: ',' };
  const known = new Set(sheet.rows.map((row) => row.file).filter(Boolean));
  const added = index.rows
    .filter((row) => row.file && !known.has(row.file))
    .map((row) => ({
      ...Object.fromEntries(INFO_COLUMNS.map((column) => [column, row[column] ?? ''])),
      name: row.name,
      tagline: row.tagline,
      card: row.question,
    }));
  const wanted = [...EDIT_COLUMNS, ...INFO_COLUMNS.filter((column) => column !== 'section' || index.columns.includes('section'))];
  const columns = [...sheet.columns, ...wanted.filter((column) => !sheet.columns.includes(column))];
  const rows = [...sheet.rows, ...added];

  if (!exists || added.length > 0) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    try {
      fs.writeFileSync(RUNNING_ORDER, formatCsv(columns, rows, sheet.delimiter));
    } catch (err) {
      if (!exists) throw err;
      console.warn(`Could not add ${added.length} new clip(s) to ${relative(RUNNING_ORDER)} (${err.code}). ` +
        'Is it open in a spreadsheet app? Carrying on with what is already in it.');
      return { rows: sheet.rows, created: false, added: 0 };
    }
  }
  return { rows, created: !exists, added: added.length };
}

function printNextSteps(clipCount) {
  console.log(`
Next:
  1. Open ${relative(RUNNING_ORDER)} in a spreadsheet app. Watch the clips in the
     recordings folder (the "file" column says which is which).
  2. Number the clips you want in the "order" column: 1, 2, 3... Leave it empty to
     leave a clip out. Decimals like 2.5 slot a clip in between.
  3. Optional: trim with "start" and "end" (seconds into the clip, like 4 or 12.5),
     fix the "name" and "tagline", or change the question card in "card". Clear
     "card" for no card. Consecutive clips with the same card share one.
  4. Save it as CSV and run npm run compile again.

Or run npm run compile -- --all for a quick test film of all ${clipCount} clips.`);
}

function chooseRows(rows, useAll) {
  // Every column is a string, even if the spreadsheet lost one. Row 1 is the header.
  const blank = Object.fromEntries([...EDIT_COLUMNS, ...INFO_COLUMNS].map((column) => [column, '']));
  const numbered = rows.map((row, i) => ({ ...blank, ...row, line: i + 2 }));
  if (useAll) return numbered.filter((row) => row.file || row.card);
  return numbered
    .filter((row) => row.order)
    .map((row) => {
      const order = Number(row.order.replace(',', '.'));
      if (!Number.isFinite(order)) throw new UserError(`Row ${row.line}: order "${row.order}" should be a number`);
      if (!row.file && !row.card) throw new UserError(`Row ${row.line} has an order but no file or card`);
      return { ...row, sortKey: order };
    })
    .sort((a, b) => a.sortKey - b.sortKey || a.line - b.line);
}

// --- Planning the film ---

// Each segment knows how to render itself, plus the stills and graphics it needs first.
// Its cache key covers everything that affects the result.
function planFilm(rows, config, recordingsDir, allTimestamps) {
  const { birthdayName, compilation: settings } = config;
  const showTitle = `${birthdayName} · ${SHOW_NAME}`;
  const graphicsSource = hash(['graphics.html', ...['theme.css', 'style.css'].map((file) => path.join('..', '..', 'public', file))]
    .map((file) => fs.readFileSync(path.resolve(path.dirname(GRAPHICS_PAGE), file), 'utf8')).join('\n'));

  const stills = new Map();
  const still = (input, time) => {
    const key = hash({ RENDER_VERSION, input: fileIdentity(input), time: toFrames(time) });
    const file = path.join(CACHE_DIR, 'stills', `${key}.jpg`);
    stills.set(file, { input, time, file });
    return pathToFileURL(file).href;
  };
  const graphics = new Map();
  const graphic = (spec) => {
    const file = path.join(CACHE_DIR, 'graphics', `${hash({ RENDER_VERSION, graphicsSource, WIDTH, HEIGHT, spec })}.png`);
    graphics.set(file, { spec, file });
    return file;
  };
  const resolveMedia = (file, what) => {
    const resolved = path.resolve(ROOT, file);
    if (!fs.existsSync(resolved)) throw new UserError(`${what} "${file}" in config.json was not found`);
    return resolved;
  };

  const answers = rows.filter((row) => row.file).map((row) => {
    const input = path.resolve(recordingsDir, row.file);
    if (!fs.existsSync(input)) throw new UserError(`Row ${row.line}: ${row.file} was not found in ${relative(recordingsDir)}`);
    const { duration: length, hasAudio } = probe(input);
    const start = parseSeconds(row.start, 'start', row.line) ?? 0;
    const end = Math.min(parseSeconds(row.end, 'end', row.line) ?? length, length);
    if (end - start < 0.2) {
      throw new UserError(`Row ${row.line}: nothing left to show between start ${start}s and end ${end}s (the clip is ${length.toFixed(1)}s long)`);
    }
    return { row, input, hasAudio, start, duration: toFrames(end - start) };
  });
  const answerFor = new Map(answers.map((answer) => [answer.row, answer]));

  // Each guest's first answer, for the faces behind the titles and the names in the credits.
  const people = new Map();
  for (const answer of answers) {
    const person = answer.row.name.trim().toLowerCase();
    if (person && !people.has(person)) people.set(person, answer);
  }
  const step = Math.max(1, people.size / MAX_MOSAIC_STILLS);
  const faces = Array.from({ length: Math.min(people.size, MAX_MOSAIC_STILLS) }, (_, i) => [...people.values()][Math.floor(i * step)])
    .map((answer) => still(answer.input, answer.start + answer.duration / 2));

  const segments = [];
  const add = (segment) => segments.push({ ...segment, key: `${segment.kind}-${hash({ RENDER_VERSION, ENCODE_ARGS, ...segment.cacheKey })}` });

  // Opening titles: a ready-made video if there is one, otherwise the title over guests' faces.
  if (settings.introVideo) {
    const input = resolveMedia(settings.introVideo, 'introVideo');
    const { duration, hasAudio } = probe(input);
    const job = { input, start: 0, duration: toFrames(duration), hasAudio, overlays: [], levelAudio: false };
    add({ kind: 'intro', label: 'Opening titles', chapter: 'Opening titles', duration: job.duration, cacheKey: { job, input: fileIdentity(input) }, render: (out) => renderVideo(job, out) });
  } else {
    const music = settings.introMusic && { file: resolveMedia(settings.introMusic, 'introMusic'), offset: 0, fadeOut: 1.5 };
    const job = {
      layers: [
        { png: graphic({ type: 'intro-background', stills: faces }) },
        { png: graphic({ type: 'intro-title', label: INTRO_LABEL, title: `${birthdayName}\n${SHOW_NAME}`, highlight: SHOW_NAME, note: dateRange(allTimestamps) }) },
      ],
      duration: INTRO_SECONDS,
      fadeIn: 0.6,
      fadeOut: 0.5,
      music,
    };
    add({ kind: 'intro', label: 'Opening titles', chapter: 'Opening titles', duration: job.duration, cacheKey: { job, music: music && fileIdentity(music.file) }, render: (out) => renderStill(job, out) });
  }

  const bug = graphic({ type: 'bug', showTitle });
  let lastCard = null;
  let lastPerson = null;
  for (const row of rows) {
    const answer = answerFor.get(row);
    const card = row.card.trim();
    if (card && (card !== lastCard || !answer)) {
      const words = card.split(/\s+/).length;
      const background = answer ? still(answer.input, answer.start + Math.min(1.5, answer.duration / 3)) : null;
      // A card on a row with no clip is a heading, like "And now… the toasts", not a question.
      const label = answer ? CARD_LABEL : '';
      const job = {
        layers: [{ png: graphic({ type: 'card', label, question: card, highlight: birthdayName, still: background, showTitle }) }],
        duration: toFrames(clamp(2 + words * 0.3, 3, 6.5)),
      };
      add({ kind: 'card', label: `Card: ${card}`, chapter: card, duration: job.duration, cacheKey: job, render: (out) => renderStill(job, out) });
      lastCard = card;
    }
    if (!answer) continue;

    const name = row.name.trim();
    const tagline = row.tagline.trim();
    const person = `${name}\n${tagline}`;
    const overlays = [{ png: bug }];
    // Name the guest when they first appear, not again for their next answer straight after.
    if (name && person !== lastPerson) {
      const showFor = Math.min(settings.lowerThirdSeconds, answer.duration - 0.6);
      overlays.push({ png: graphic({ type: 'lower-third', name, tagline }), showFor: showFor > 1 ? showFor : 0 });
    }
    lastPerson = person;
    const job = { input: answer.input, start: answer.start, duration: answer.duration, hasAudio: answer.hasAudio, overlays, levelAudio: settings.normalizeAudio };
    add({
      kind: 'answer',
      label: `${name || path.basename(row.file)}: ${row.question || row.card || row.file}`,
      duration: job.duration,
      cacheKey: { job, input: fileIdentity(answer.input) },
      render: (out) => renderVideo(job, out),
    });
  }

  // The ending: a freeze frame of the last answer, like the booth's wrap screen, then credits.
  const last = answers.at(-1);
  const names = [...people.values()].map((answer) => answer.row.name.trim());
  const credits = names.length > 0 ? toFrames(clamp(4 + names.length * 0.12, 5, 9)) : 0;
  const outroMusic = settings.outroMusic && resolveMedia(settings.outroMusic, 'outroMusic');
  const outroTitle = settings.outroTitle.replaceAll('{birthday}', birthdayName);
  const wrap = {
    layers: [{
      png: graphic({
        type: 'wrap',
        title: outroTitle,
        // Like the booth's "That's a wrap, Sam.", the full stop goes in the highlight too.
        highlight: outroTitle.includes(`${birthdayName}.`) ? `${birthdayName}.` : birthdayName,
        note: settings.outroNote,
        still: last ? still(last.input, last.start + last.duration - 0.1) : null,
      }),
    }],
    duration: WRAP_SECONDS,
    fadeIn: 0,
    fadeOut: credits ? 0.3 : 1,
    music: outroMusic && { file: outroMusic, offset: 0, fadeIn: 0.5, fadeOut: credits ? 0 : 1 },
  };
  add({ kind: 'wrap', label: 'Wrap', chapter: 'Happy birthday', duration: wrap.duration, cacheKey: { wrap, music: outroMusic && fileIdentity(outroMusic) }, render: (out) => renderStill(wrap, out) });

  if (credits) {
    const job = {
      layers: [{ png: graphic({ type: 'credits', label: CREDITS_LABEL, names, stills: faces }) }],
      duration: credits,
      fadeOut: 1.5,
      music: outroMusic && { file: outroMusic, offset: WRAP_SECONDS, fadeOut: 2 },
    };
    add({ kind: 'credits', label: 'Credits', chapter: 'Credits', duration: job.duration, cacheKey: { job, music: outroMusic && fileIdentity(outroMusic) }, render: (out) => renderStill(job, out) });
  }

  return { segments, stills: [...stills.values()], graphics: [...graphics.values()], showTitle };
}

// --- Rendering ---

async function renderFilm(plan) {
  for (const dir of ['segments', 'stills', 'graphics']) fs.mkdirSync(path.join(CACHE_DIR, dir), { recursive: true });
  for (const segment of plan.segments) segment.output = path.join(CACHE_DIR, 'segments', `${segment.key}.mp4`);
  const todo = plan.segments.filter((segment) => !fs.existsSync(segment.output));

  // Stills first, then all the graphics in one browser session, then the video.
  const missingStills = plan.stills.filter((s) => !fs.existsSync(s.file));
  if (missingStills.length) console.log(`Grabbing ${missingStills.length} still(s)...`);
  for (const s of missingStills) extractStill(s.input, s.time, s.file);

  const missingGraphics = plan.graphics.filter((g) => !fs.existsSync(g.file));
  if (missingGraphics.length) {
    console.log(`Drawing ${missingGraphics.length} graphic(s)...`);
    const graphics = await openGraphics({ width: WIDTH, height: HEIGHT, profileDir: path.join(CACHE_DIR, 'browser-profile') });
    try {
      for (const g of missingGraphics) await graphics.render(g.spec, g.file);
    } finally {
      graphics.close();
    }
  }

  const cached = plan.segments.length - todo.length;
  console.log(`Rendering ${todo.length} piece(s)${cached ? `, ${cached} already done` : ''}...`);
  todo.forEach((segment, i) => {
    console.log(`  [${i + 1}/${todo.length}] ${segment.label}`);
    segment.render(segment.output);
  });
}

function escapeMetadata(value) {
  return String(value).replace(/[=;#\\\n]/g, (char) => `\\${char}`);
}

function joinSegments(plan, output) {
  const list = path.join(CACHE_DIR, 'concat.txt');
  fs.writeFileSync(list, plan.segments
    .map((segment) => `file '${segment.output.replaceAll('\\', '/').replaceAll("'", "'\\''")}'`)
    .join('\n'));

  // Chapters let you skip from question to question in VLC and most players.
  const chapters = [];
  let time = 0;
  for (const segment of plan.segments) {
    if (segment.chapter) chapters.push({ title: segment.chapter, start: time });
    time += segment.duration;
  }
  const metadata = path.join(CACHE_DIR, 'chapters.txt');
  fs.writeFileSync(metadata, [
    ';FFMETADATA1',
    `title=${escapeMetadata(plan.showTitle)}`,
    ...chapters.flatMap((chapter, i) => [
      '[CHAPTER]',
      'TIMEBASE=1/1000',
      `START=${Math.round(chapter.start * 1000)}`,
      `END=${Math.round((chapters[i + 1]?.start ?? time) * 1000)}`,
      `title=${escapeMetadata(chapter.title)}`,
    ]),
  ].join('\n'));

  const partial = `${output}.partial.mp4`;
  try {
    // The video is copied as is; the audio is re-encoded so the joins are seamless.
    ffmpeg([
      '-f', 'concat', '-safe', '0', '-i', list, '-i', metadata,
      '-map', '0:v', '-map', '0:a', '-map_metadata', '1', '-map_chapters', '1',
      '-c:v', 'copy', '-af', 'aresample=async=1', '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart', partial,
    ], 'Joining the pieces');
    try {
      fs.renameSync(partial, output);
    } catch (err) {
      throw new UserError(`Could not replace ${relative(output)} (${err.code}). Is it open in a video player? Close it and run this again.`);
    }
  } finally {
    fs.rmSync(partial, { force: true });
  }
  return time;
}

// --- Main ---

async function main() {
  const useAll = process.argv.includes('--all');
  for (const [command, name] of [[FFMPEG, 'ffmpeg'], [FFPROBE, 'ffprobe']]) {
    if (spawnSync(command, ['-version'], { stdio: 'ignore' }).error) {
      throw new UserError(`${name} was not found. Install ffmpeg (Linux: sudo apt install ffmpeg, Windows: winget install ffmpeg) or set ${name.toUpperCase()} to its path.`);
    }
  }

  const config = loadConfig();
  const recordingsDir = path.resolve(ROOT, config.recordingsDir);
  const index = readIndex(recordingsDir);
  if (index.rows.length === 0 && !fs.existsSync(RUNNING_ORDER)) {
    throw new UserError(`No clips yet: ${relative(path.join(recordingsDir, 'index.csv'))} is missing or empty.`);
  }

  const { rows, created, added } = updateRunningOrder(index);
  if (created) console.log(`Created ${relative(RUNNING_ORDER)} with ${rows.length} clips.`);
  else if (added) console.log(`Added ${added} new clip(s) to ${relative(RUNNING_ORDER)}.`);

  const chosen = chooseRows(rows, useAll);
  if (chosen.length === 0) {
    if (!created) console.log(`No clips are numbered in the "order" column of ${relative(RUNNING_ORDER)} yet.`);
    printNextSteps(rows.length);
    return;
  }

  const plan = planFilm(chosen, config, recordingsDir, index.rows.map((row) => row.recorded_at));
  const clipCount = plan.segments.filter((segment) => segment.kind === 'answer').length;
  console.log(`Making a film of ${clipCount} clip(s) in ${plan.segments.length} pieces.`);
  await renderFilm(plan);

  const output = path.join(OUTPUT_DIR, `${slugify(plan.showTitle) || 'compilation'}.mp4`);
  const seconds = joinSegments(plan, output);
  const minutes = Math.floor(seconds / 60);
  console.log(`\nDone: ${relative(output)} (${minutes}:${String(Math.round(seconds % 60)).padStart(2, '0')} long)`);
}

main().catch((err) => {
  console.error(err instanceof UserError ? err.message : err);
  process.exitCode = 1;
});
