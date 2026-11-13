// Settings page: edits config.json and questions.txt through the booth server,
// with a live preview of the chosen camera and a level meter for the mic.

import { cameraErrorMessage, findDevice, mediaConstraints } from './media.js';
import { STRINGS } from './strings.js';

const $ = (id) => document.getElementById(id);

const NUMBER_FIELDS = ['maxSecondsPerQuestion', 'countdownSeconds', 'thankYouSeconds'];
const MIX_SECTIONS = ['funny', 'cute', 'last']; // the questionMix-<section> fields
const DEFAULT_SECTION = 'funny'; // for questions above the first [section] line, as on the server
const AUDIO_BITS_PER_SECOND = 128_000; // what the booth records audio at, for the disk estimate
// Chrome on Windows lists these aliases next to the real devices; "System default" covers them.
const ALIAS_DEVICE_IDS = new Set(['default', 'communications']);
const METER_FLOOR_DB = -60;
const LANGUAGE_SEPARATOR = '|'; // between the languages on a line of questions.txt, as on the server

const form = $('settings-form');
let stream = null;
let previewAttempt = 0;
let audioContext = null;
let meter = null; // { source, frame }
let dirty = false;
let languages = ['en']; // from config.json: the columns of questions.txt, the first being the default

// --- Small helpers ---

async function requestJson(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body && JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function setStatus(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('is-error', isError);
}

function showPreviewMessage(message) {
  $('preview-message').textContent = message;
  $('preview-message').hidden = !message;
}

// --- The form ---

const languageName = (code) => STRINGS[code]?.languageNameInEnglish ?? code;

// "French and English", "French, English and German"
function listNames(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names.join('');
}

function fillForm(settings, questions) {
  languages = settings.languages;
  if (languages.length > 1) {
    const names = languages.map(languageName);
    $('languages-hint').textContent = `Write each question as ${names.join(' | ')}. ` +
      `Guests pick their language and only get questions in it, so a line with no | is only asked in ${names[0]}. `;
  }
  $('birthdayName').value = settings.birthdayName;
  for (const key of NUMBER_FIELDS) $(key).value = settings[key];
  for (const section of MIX_SECTIONS) $(`questionMix-${section}`).value = settings.questionMix[section] ?? 0;
  $('videoMbps').value = settings.videoBitsPerSecond / 1_000_000;
  $('questions').value = questions;
  updateDiskEstimate();
  updateQuestionCount();
}

function readForm() {
  return {
    birthdayName: $('birthdayName').value.trim(),
    ...Object.fromEntries(NUMBER_FIELDS.map((key) => [key, $(key).valueAsNumber])),
    questionMix: readMix(),
    videoBitsPerSecond: Math.round($('videoMbps').valueAsNumber * 1_000_000),
    cameraName: $('cameraName').value,
    microphoneName: $('microphoneName').value,
  };
}

function updateDiskEstimate() {
  const bitsPerSecond = $('videoMbps').valueAsNumber * 1_000_000 + AUDIO_BITS_PER_SECOND;
  const gbPerHour = (bitsPerSecond * 3600) / 8 / 1e9;
  $('disk-estimate').textContent = Number.isFinite(gbPerHour) ? `About ${gbPerHour.toFixed(1)} GB per hour of answers.` : '';
}

function readMix() {
  return Object.fromEntries(MIX_SECTIONS.map((section) => [section, $(`questionMix-${section}`).valueAsNumber]));
}

// Counts questions the way the server reads questions.txt: blank lines, # comments
// and the [section] lines themselves don't count. Returns { section: count } and
// { language: count }, for the questions with a version in each language.
function countQuestions(text) {
  let section = DEFAULT_SECTION;
  const counts = {};
  const byLanguage = Object.fromEntries(languages.map((code) => [code, 0]));
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const header = line.match(/^\[\s*(.+?)\s*\]$/);
    if (header) {
      section = header[1].toLowerCase();
      continue;
    }
    const columns = line.split(LANGUAGE_SEPARATOR).map((column) => column.trim());
    const present = languages.filter((code, i) => columns[i]);
    if (present.length === 0) continue;
    counts[section] = (counts[section] ?? 0) + 1;
    for (const code of present) byLanguage[code] += 1;
  }
  return { counts, byLanguage };
}

// " Only 30 are in English." or " Every one is in French and English."
function describeLanguages(byLanguage, total) {
  if (languages.length < 2) return '';
  const short = languages.filter((code) => byLanguage[code] < total);
  if (short.length === 0) return ` Every one is in ${listNames(languages.map(languageName))}.`;
  return short.map((code) => {
    const count = byLanguage[code];
    return count === 0 ? ` None are in ${languageName(code)} yet.` : ` Only ${count} ${count === 1 ? 'is' : 'are'} in ${languageName(code)}.`;
  }).join('');
}

// "3 [funny], 1 [cute] and 1 [last]", leaving out zeros.
function describeCounts(counts) {
  return listNames(Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([section, count]) => `${count} [${section}]`));
}

function updateQuestionCount() {
  const { counts, byLanguage } = countQuestions($('questions').value);
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  const mix = readMix();
  const perGuest = Object.values(mix).reduce((sum, count) => sum + (Number.isFinite(count) ? count : 0), 0);
  $('questions').setCustomValidity(total ? '' : 'Add at least one question.');
  $('questionMix-funny').setCustomValidity(perGuest ? '' : 'Each guest needs at least one question.');
  $('question-count').textContent = total === 0
    ? 'No questions yet.'
    : `${total} question${total === 1 ? '' : 's'}: ${describeCounts(counts)}.` +
      describeLanguages(byLanguage, total) +
      (perGuest ? ` Each guest gets ${describeCounts(mix)}, picked at random.` : '');
}

// --- Camera, mic and preview ---

// Options are labelled and valued by device name, which is what config.json stores.
// A saved name that matches nothing stays selected, so saving doesn't quietly drop it.
function fillDeviceSelect(select, devices, kind, wanted) {
  const choices = devices.filter((d) => d.kind === kind && d.label && !ALIAS_DEVICE_IDS.has(d.deviceId));
  const options = [new Option('System default', '')];
  for (const device of choices) {
    const option = new Option(device.label, device.label);
    option.dataset.deviceId = device.deviceId;
    options.push(option);
  }
  const match = findDevice(choices, kind, wanted);
  if (wanted && !match) options.push(new Option(`${wanted} (not found)`, wanted));
  select.replaceChildren(...options);
  select.value = match?.label ?? wanted;
}

async function listDevices(camera = $('cameraName').value, microphone = $('microphoneName').value) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  fillDeviceSelect($('cameraName'), devices, 'videoinput', camera);
  fillDeviceSelect($('microphoneName'), devices, 'audioinput', microphone);
}

const selectedDeviceId = (select) => select.selectedOptions[0]?.dataset.deviceId;

function stopPreview() {
  if (meter) {
    cancelAnimationFrame(meter.frame);
    meter.source.disconnect();
    meter = null;
  }
  $('mic-level').style.transform = '';
  for (const track of stream?.getTracks() ?? []) track.stop();
  stream = null;
}

async function startPreview() {
  if (!navigator.mediaDevices) return;
  const attempt = ++previewAttempt;
  stopPreview();
  showPreviewMessage('Waking up the camera…');
  let opened;
  try {
    // The booth's own constraints, so the meter hears what gets recorded and
    // auto gain stays off here too.
    opened = await navigator.mediaDevices.getUserMedia(
      mediaConstraints(selectedDeviceId($('cameraName')), selectedDeviceId($('microphoneName'))),
    );
  } catch (err) {
    console.error('getUserMedia failed:', err);
    if (attempt === previewAttempt) showPreviewMessage(cameraErrorMessage(err));
    return;
  }
  // A newer pick arrived while this one was opening.
  if (attempt !== previewAttempt) {
    for (const track of opened.getTracks()) track.stop();
    return;
  }

  stream = opened;
  $('preview').srcObject = stream;
  showPreviewMessage('');
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => showPreviewMessage('The camera or microphone was disconnected. Plug it back in, or pick another one.'));
  }
  startMeter(stream);
}

// Peak level on a -60 to 0 dB scale, falling back gently like a hardware meter.
function startMeter(source) {
  if (source.getAudioTracks().length === 0) return;
  audioContext ??= new AudioContext();
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  meter = { source: audioContext.createMediaStreamSource(source), frame: 0 };
  meter.source.connect(analyser);

  const samples = new Float32Array(analyser.fftSize);
  const fill = $('mic-level');
  let level = 0;
  const draw = () => {
    analyser.getFloatTimeDomainData(samples);
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    const db = 20 * Math.log10(Math.max(peak, 1e-6));
    level = Math.max(Math.min(1, 1 - db / METER_FLOOR_DB), level * 0.92, 0);
    fill.style.transform = `scaleX(${level})`;
    fill.classList.toggle('is-clipping', peak >= 0.98);
    meter.frame = requestAnimationFrame(draw);
  };
  draw();
}

// --- Wiring ---

form.addEventListener('input', (event) => {
  dirty = true;
  setStatus('Unsaved changes');
  if (event.target.id === 'videoMbps') updateDiskEstimate();
  if (event.target.id === 'questions' || event.target.id.startsWith('questionMix-')) updateQuestionCount();
});

$('cameraName').addEventListener('change', startPreview);
$('microphoneName').addEventListener('change', startPreview);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  $('save-button').disabled = true;
  setStatus('Saving…');
  try {
    await requestJson('/api/settings', { method: 'PUT', body: readForm() });
    await requestJson('/api/questions', { method: 'PUT', body: { text: $('questions').value } });
    dirty = false;
    setStatus('Saved. Go back to the booth to use the new settings.');
  } catch (err) {
    setStatus(`Not saved: ${err.message}`, true);
  } finally {
    $('save-button').disabled = false;
  }
});

addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 's') {
    event.preventDefault();
    if (!$('save-button').disabled) form.requestSubmit();
  }
});

// Chrome keeps audio suspended until the first click or key press on a page.
for (const type of ['pointerdown', 'keydown']) addEventListener(type, () => audioContext?.resume());

addEventListener('beforeunload', (event) => {
  if (dirty) event.preventDefault();
});
// Free the camera straight away, so the booth can open it.
addEventListener('pagehide', stopPreview);

async function init() {
  let settings;
  let questions;
  try {
    [settings, { text: questions }] = await Promise.all([requestJson('/api/settings'), requestJson('/api/questions')]);
  } catch (err) {
    return setStatus(`Can't reach the booth server (${err.message}). Check it's running, then reload this page.`, true);
  }
  fillForm(settings, questions);
  $('save-button').disabled = false;
  setStatus('');

  // Only secure pages (like localhost) get the camera, so not this page opened from another computer.
  if (!navigator.mediaDevices) {
    fillDeviceSelect($('cameraName'), [], 'videoinput', settings.cameraName);
    fillDeviceSelect($('microphoneName'), [], 'audioinput', settings.microphoneName);
    return showPreviewMessage('The preview only works on the booth computer itself.');
  }

  // Device names are only readable once camera access is granted, so open the
  // defaults first, then switch to the saved camera and mic.
  await startPreview();
  await listDevices(settings.cameraName, settings.microphoneName);
  if (selectedDeviceId($('cameraName')) || selectedDeviceId($('microphoneName'))) await startPreview();

  navigator.mediaDevices.addEventListener('devicechange', async () => {
    await listDevices();
    if (!stream?.getTracks().every((track) => track.readyState === 'live')) startPreview();
  });
}

init();
