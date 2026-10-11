// Confession booth front end: camera preview, session flow, and per-question
// recording. Each question is its own MediaRecorder, streamed to the server in
// small chunks so a crash loses at most a couple of seconds.

const $ = (id) => document.getElementById(id);

// MP4 with AAC audio is the friendliest for video editors; fall back from there.
const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.640028,mp4a.40.2',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1.640028,opus',
  'video/mp4;codecs=avc1.42E01E,opus',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];
const CHUNK_MS = 2000;
const NEXT_GUARD_MS = 1000; // ignore Next this soon after a question appears, so a double-press can't skip one
const UPLOAD_ATTEMPTS = 3;
const HURRY_SECONDS = 10;
const SCREENS = ['loading', 'start', 'countdown', 'question', 'thanks', 'error'];

const booth = document.querySelector('.booth');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let settings = null;
let stream = null;
let mimeType = '';
let session = null;

// --- Small helpers ---

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function show(screen) {
  for (const name of SCREENS) $(`screen-${name}`).hidden = name !== screen;
  booth.dataset.state = screen;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function formatSeconds(total) {
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds} left`;
}

// --- Camera & screen ---

function mediaConstraints(cameraId, microphoneId) {
  return {
    video: { deviceId: cameraId && { exact: cameraId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    // Nothing plays through the speakers, so echo cancellation would only degrade the audio.
    audio: { deviceId: microphoneId && { exact: microphoneId }, echoCancellation: false },
  };
}

// Device labels are only readable once permission is granted, so open the
// defaults first, then switch if config.json names a specific camera or mic.
async function startCamera() {
  stream = await navigator.mediaDevices.getUserMedia(mediaConstraints());

  const devices = await navigator.mediaDevices.enumerateDevices();
  const labels = (kind) => devices.filter((d) => d.kind === kind).map((d) => `"${d.label}"`).join(', ');
  console.log(`Cameras: ${labels('videoinput')}`);
  console.log(`Microphones: ${labels('audioinput')}`);

  const pick = (kind, name) => {
    if (!name) return undefined;
    const device = devices.find((d) => d.kind === kind && d.label.toLowerCase().includes(name.toLowerCase()));
    if (!device) console.warn(`No ${kind} matching "${name}", using the default`);
    return device?.deviceId;
  };
  const cameraId = pick('videoinput', settings.cameraName);
  const microphoneId = pick('audioinput', settings.microphoneName);
  if (cameraId || microphoneId) {
    for (const track of stream.getTracks()) track.stop();
    stream = await navigator.mediaDevices.getUserMedia(mediaConstraints(cameraId, microphoneId));
  }

  $('preview').srcObject = stream;
  for (const track of stream.getTracks()) {
    track.addEventListener('ended', () => fail('The camera or microphone was disconnected. Plug it back in, then try again.'));
  }
}

function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
      return 'Camera access is blocked. Allow the camera and microphone for this page in the browser settings, then try again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera or microphone was found. Plug them in, then try again.';
    case 'NotReadableError':
      return 'The camera is being used by another app. Close that app, then try again.';
    default:
      return `The camera couldn't start (${err?.message ?? 'unknown error'}). Try again.`;
  }
}

async function keepScreenAwake() {
  if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    await navigator.wakeLock.request('screen');
  } catch (err) {
    console.warn('Screen wake lock unavailable:', err.message);
  }
}

// --- Recording ---

async function uploadChunk(sessionId, clipNumber, seq, blob, type) {
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`/api/session/${sessionId}/clip/${clipNumber}/chunk?seq=${seq}`, {
        method: 'POST',
        headers: { 'Content-Type': type },
        body: blob,
      });
      if (res.ok) return;
      const { error } = await res.json().catch(() => ({}));
      // 4xx won't fix itself on retry (e.g. the server restarted and forgot the session).
      if (res.status < 500) return console.error(`Chunk ${seq} of clip ${clipNumber} rejected: ${error ?? res.status}`);
    } catch (err) {
      console.warn(`Chunk ${seq} of clip ${clipNumber} failed (attempt ${attempt}):`, err.message);
    }
    await sleep(500 * attempt);
  }
  console.error(`Gave up uploading chunk ${seq} of clip ${clipNumber}`);
}

function startClip(sessionId, clipNumber) {
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: settings.videoBitsPerSecond,
    audioBitsPerSecond: 128_000,
  });
  const startedAt = new Date().toISOString();
  let seq = 0;
  let uploads = Promise.resolve(); // sequential, so chunks are appended in order

  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size === 0) return;
    const chunkSeq = seq++;
    uploads = uploads.then(() => uploadChunk(sessionId, clipNumber, chunkSeq, event.data, recorder.mimeType || mimeType));
  });
  recorder.addEventListener('error', (event) => console.error(`Recorder error on clip ${clipNumber}:`, event.error));
  const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve, { once: true }));
  recorder.start(CHUNK_MS);

  return {
    async finish(endedBy) {
      const endedAt = new Date().toISOString();
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      await uploads;
      await postJson(`/api/session/${sessionId}/clip/${clipNumber}/end`, { startedAt, endedAt, endedBy })
        .catch((err) => console.error(`Could not finish clip ${clipNumber}:`, err.message));
    },
  };
}

// --- Session flow ---

async function beginSession(name) {
  const data = await postJson('/api/session', { name });
  settings = data.settings;
  session = {
    id: data.sessionId,
    name,
    questions: data.questions,
    index: -1,
    clip: null,
    finishing: [],
    questionShownAt: 0,
    timerInterval: null,
    timerTimeout: null,
    ending: false,
  };
  booth.classList.add('is-open');
  await runCountdown(settings.countdownSeconds, name);
  if (session.ending) return; // the camera failed during the countdown
  showQuestion(0);
}

async function runCountdown(seconds, name) {
  if (seconds <= 0) return;
  $('countdown-greeting').textContent = `Get ready, ${name}.`;
  show('countdown');
  const numeral = $('countdown-number');
  for (let n = seconds; n > 0; n--) {
    numeral.textContent = n;
    if (!reducedMotion.matches) {
      numeral.animate(
        [{ opacity: 0, transform: 'scale(1.35)' }, { opacity: 1, transform: 'scale(1)' }],
        { duration: 450, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
      );
    }
    await sleep(1000);
  }
}

function showQuestion(index) {
  const { questions } = session;
  session.index = index;
  session.questionShownAt = performance.now();
  $('question-progress').textContent = `Question ${index + 1} of ${questions.length}`;
  $('question-text').textContent = questions[index];
  $('next-button').textContent = index === questions.length - 1 ? 'Finish' : 'Next question';
  show('question');
  $('rec-badge').hidden = false;
  session.clip = startClip(session.id, index + 1);
  startTimer(settings.maxSecondsPerQuestion);
}

function startTimer(seconds) {
  const fill = $('timer-fill');
  for (const animation of fill.getAnimations()) animation.cancel();
  fill.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: seconds * 1000, fill: 'forwards' });

  const deadline = performance.now() + seconds * 1000;
  const update = () => {
    const left = Math.max(0, Math.ceil((deadline - performance.now()) / 1000));
    $('timer-label').textContent = formatSeconds(left);
    $('screen-question').classList.toggle('is-hurry', left <= HURRY_SECONDS);
  };
  update();
  session.timerInterval = setInterval(update, 250);
  session.timerTimeout = setTimeout(() => advance('timer'), seconds * 1000);
}

function stopTimer() {
  clearInterval(session.timerInterval);
  clearTimeout(session.timerTimeout);
}

function advance(endedBy) {
  if (!session || session.ending || booth.dataset.state !== 'question') return;
  if (endedBy === 'next' && performance.now() - session.questionShownAt < NEXT_GUARD_MS) return;
  stopTimer();
  // Finish the old clip in the background while the next one starts, so there's no gap.
  session.finishing.push(session.clip.finish(endedBy));
  if (session.index + 1 < session.questions.length) {
    showQuestion(session.index + 1);
  } else {
    endSession('completed');
  }
}

function endEarly() {
  if (!session || session.ending || booth.dataset.state !== 'question') return;
  stopTimer();
  session.finishing.push(session.clip.finish('escape'));
  endSession('ended-early');
}

async function finalizeSession(current, status) {
  await Promise.all(current.finishing);
  await postJson(`/api/session/${current.id}/end`, { status })
    .catch((err) => console.error('Could not finish session:', err.message));
}

async function endSession(status) {
  session.ending = true;
  $('rec-badge').hidden = true;
  const finalized = finalizeSession(session, status);

  $('thanks-title').textContent = `Bless you, ${session.name}.`;
  show('thanks');
  for (let left = settings.thankYouSeconds; left > 0; left--) {
    $('thanks-reset').textContent = `The booth resets in ${left} second${left === 1 ? '' : 's'}.`;
    await sleep(1000);
  }
  await finalized;
  // A fresh page per session keeps a multi-day run free of leaks and stale state.
  location.reload();
}

function fail(message) {
  if (session && !session.ending) {
    session.ending = true;
    stopTimer();
    if (session.clip) session.finishing.push(session.clip.finish('escape'));
    finalizeSession(session, 'ended-early');
  }
  $('rec-badge').hidden = true;
  $('error-message').textContent = message;
  show('error');
}

// --- Wiring ---

$('start-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('name').value.trim();
  if (!name) return;
  $('start-button').disabled = true;
  try {
    await beginSession(name);
  } catch (err) {
    console.error('Could not start session:', err);
    fail("The booth couldn't start a session. Check the booth server is running, then try again.");
  }
});

$('next-button').addEventListener('click', () => advance('next'));
$('retry-button').addEventListener('click', () => location.reload());

document.addEventListener('keydown', (event) => {
  if (booth.dataset.state !== 'question' || event.repeat) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    endEarly();
  } else if ([' ', 'Enter', 'ArrowRight'].includes(event.key) && event.target !== $('next-button')) {
    // When the button itself has focus, its own click handles Space and Enter.
    event.preventDefault();
    advance('next');
  }
});

document.addEventListener('visibilitychange', keepScreenAwake);

async function init() {
  keepScreenAwake();
  try {
    settings = await fetch('/api/settings').then((res) => res.json());
  } catch {
    return fail("Can't reach the booth server. Check it's running, then try again.");
  }

  mimeType = MIME_CANDIDATES.find((type) => window.MediaRecorder?.isTypeSupported(type)) ?? '';
  if (!mimeType) return fail('This browser cannot record video. Open the booth in Google Chrome or Microsoft Edge.');
  console.log(`Recording as ${mimeType}`);

  try {
    await startCamera();
  } catch (err) {
    console.error('getUserMedia failed:', err);
    return fail(cameraErrorMessage(err));
  }

  const { questionsPerSession: count, maxSecondsPerQuestion: seconds } = settings;
  $('start-note').textContent =
    `You'll get ${count} question${count === 1 ? '' : 's'}, with up to ${seconds} seconds for each. ` +
    'Everything you say is recorded for the birthday film.';
  show('start');
  $('name').focus();
}

init();
