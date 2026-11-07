# Confession Booth: Plan

## Context
This is a single-machine "confession booth" for a birthday weekend. Guests enter their names, then answer a few randomly chosen questions on camera. Each answer is saved as its own video clip with metadata, so the clips can be edited into a funny compilation afterwards. The booth runs unattended for days, so it has to be reliable and recover by itself.

The booth must run on either Linux or Windows. Dev machine: Node 24, Google Chrome 155, webcam at `/dev/video0`, ffmpeg 8.

**Decisions made with the user:** one clip per question; a Next button plus a max timer per question; N random questions per session drawn from a pool; keyboard and mouse input.

**Why web and not native:** we considered Electron, Tauri, Python+OpenCV, PySide6/Qt Multimedia, GStreamer, an ffmpeg-driven capture, and OBS+websocket. Native options would mainly give better footage: a constant frame rate and better encoding. The post-weekend ffmpeg conversion covers that. The UI, which is most of this project, is far cheaper in HTML/CSS. Tauri was ruled out because WebKitGTK's camera support on Linux is unreliable.

## Tech stack
- **Frontend:** plain HTML/CSS/JS with no framework or build step. `getUserMedia` and `MediaRecorder` handle capture and encoding.
- **Backend:** `server.js` uses Node's built-in `node:http` and `node:fs` with zero npm dependencies. It serves the page, picks the questions and writes the recordings to disk.
- **Runtime:** Chrome in kiosk mode on `http://localhost:3000` (localhost counts as a secure context, so camera access works) with its own profile so permissions persist.

## Files
```
confession-booth/
  package.json          # "type": "module", "start": "node server.js"
  server.js             # HTTP server + recording API
  config.json           # tunables (below)
  questions.txt         # one question per line; blank lines and #comments ignored
  public/
    index.html          # all screens as <section>s, toggled via [hidden]
    theme.css           # bundled fonts + colour tokens, shared by both pages
    style.css           # reality TV talking head: full-screen preview, question strip, name-tag lower third, REC bug, timer line
    app.js              # state machine + recorder + chunk upload queue
    media.js            # getUserMedia constraints, device matching, camera error messages (shared)
    settings.html/.css/.js  # /settings: edit config.json + questions.txt, camera preview, mic level meter
    fonts/              # Barlow + Barlow Condensed (bundled so the booth works offline)
  scripts/
    start-booth.js      # start + supervise server, then Chrome/Edge kiosk with dedicated profile
    prep-for-edit.js    # post-weekend: ffmpeg batch-transcode to constant-frame-rate H.264/AAC MP4
  start-booth.cmd       # Windows double-click launcher
  recordings/           # output (created at runtime, gitignored)
  README.md             # setup + running notes
```

The helper scripts are Node rather than bash, so the same scripts run on Windows.

`config.json` defaults: `birthdayName: "the birthday person"` (fills `{birthday}` in questions), `questionMix: {funny: 3, cute: 1, last: 1}` (questions per guest from each section of `questions.txt`), `maxSecondsPerQuestion: 90`, `countdownSeconds: 3`, `thankYouSeconds: 10`, `videoBitsPerSecond: 2500000`, `cameraName`/`microphoneName: ""` (label substring to pick a device), `host: "127.0.0.1"`, `port: 3000`, `recordingsDir: "recordings"`.

## Server (`server.js`)
- Static file serving from `public/` with a small MIME map.
- `POST /api/session` `{name, tagline?}` re-reads `questions.txt` on every call, so questions can be edited mid-weekend without a restart. It then:
  - picks questions per `questionMix` at random (Fisher–Yates): `[funny]` and `[cute]` shuffled together, then a `[last]` one (something nice about the birthday person). If a name in the name box matches `birthdayName`, questions with `{birthday}` are skipped, and short sections are topped up from the other `[funny]`/`[cute]` leftovers
  - creates `recordings/2026-10-11_14-23-05_sam-and-alex/`
  - writes the initial `session.json`
  - returns `{sessionId, questions, config}`
- `POST /api/session/:id/clip/:n/chunk?seq=K` takes the raw request body (with the recorder's MIME type as `Content-Type`) and appends it to `NN-<question-slug>.<ext>`. `seq` makes retries safe: a chunk that's already written is acknowledged without being appended again, and a gap gets a 409.
- All disk writes for a session go through one per-session promise queue, and `session.json` is written atomically (temp file + rename).
- `POST /api/session/:id/clip/:n/end` `{startedAt, endedAt, endedBy: "next"|"timer"|"escape"}` updates the clip entry in `session.json`.
- `POST /api/session/:id/end` `{status: "completed"|"ended-early"}` sets `endedAt` and `status`, and appends one row per clip to `recordings/index.csv` (session dir, name, question #, question, file, duration, endedBy, recorded at, tagline, section). This CSV gives one overview across all sessions for building "everyone answers question X" montages.
- `GET /settings` serves the settings page. `PUT /api/settings` validates the guest-facing settings (ranges, lengths, and the `funny`/`cute`/`last` counts in `questionMix`) and rewrites `config.json` atomically, keeping any other `questionMix` sections added by hand; `GET`/`PUT /api/questions` reads and writes the raw `questions.txt`. Writes use PUT, so a page on another site can't send them without a CORS preflight, which the server never grants.
- **Safety:** active sessions live in an in-memory Map, and an unknown `sessionId` gets a 404. `:n` must be an integer in range. Names and questions are slugified (lowercase, `[a-z0-9-]`, max ~40 chars) before they're used in paths. Request bodies are size-capped per chunk.
- `session.json` shape: `{name, tagline, startedAt, endedAt, status, mimeType, clips: [{index, question, section, file, startedAt, endedAt, durationSec, endedBy}]}`.

## Frontend (`public/app.js`)
**State machine:** `START → COUNTDOWN → QUESTION(i) … → THANKS → START`

- **Page load:** get the camera once (`{video: {width: 1280, height: 720, frameRate: 30}, audio: true}`) and keep the stream alive for the page's lifetime, so it isn't re-opened between questions. Show a mirrored live preview on every screen (CSS `scaleX(-1)`; the recording itself stays unmirrored).
- **START:** "Who's in the hot seat?" The name and an optional tagline are typed straight into the lower-third name tag. Enter in the name moves to the tagline; Enter there (or Roll camera) calls `POST /api/session`.
- **COUNTDOWN:** a 3-2-1 overlay, with a reminder to look at the webcam. The name tag stays on screen until the last question.
- **QUESTION(i):**
  - Show "Question i of N" and the question in a strip at the top (just under the webcam), a red pulsing ● REC bug and a shrinking timer line along the bottom.
  - Start a new `MediaRecorder(stream, {mimeType, videoBitsPerSecond})` with `start(2000)`.
  - Next button / Space / → advances, the timer auto-advances at `maxSecondsPerQuestion`, and Escape ends the session early.
  - Debounce Next for about 1s so a double-press doesn't skip a question.
  - On advance: `recorder.stop()`, wait for the final chunk and the upload queue to drain, `POST …/end`, then start the next clip right away.
- **MIME selection:** use the first type that `MediaRecorder.isTypeSupported` accepts, preferring MP4 H.264+AAC, then H.264+Opus, then WebM. Linux Chrome has no AAC encoder, so it records H.264+Opus. The prep script converts the audio to AAC.
- **Device selection:** open the default devices, list the device labels in the console, and switch if `cameraName`/`microphoneName` matches one (an exact label first, then a substring). If nothing matches, keep the default and log a warning.
- **Settings shortcut:** Ctrl+, opens `/settings` from the loading, start and error screens, never mid-session.
- **Upload queue:** a sequential promise chain so chunks append in order. Each chunk gets 3 retries with backoff, and failures are logged to the console.
- **THANKS:** "That's a wrap" over a freeze frame of the last camera frame (drawn to a canvas), then an automatic return to START after `thankYouSeconds`. The return to START does a full `location.reload()` so a multi-day run never builds up memory or stale recorder state.
- **Robustness:**
  - Screen Wake Lock, re-acquired on `visibilitychange`.
  - If `getUserMedia` fails, show an error screen with a retry button.
  - A guest who walks away mid-session is handled by the timer: the session ends on its own after N × max seconds.

## Kiosk launcher (`scripts/start-booth.js`, `start-booth.cmd`)
1. Refuses to start if the port is already serving.
2. Starts `server.js` and restarts it 2s after any crash, then waits for `/api/settings` to respond.
3. Finds Chrome, Chromium or Edge for the platform (or uses `BOOTH_BROWSER`) and launches it with `--kiosk --user-data-dir=.booth-browser-profile --use-fake-ui-for-media-stream …`. The media flag auto-grants camera and mic in this dedicated profile only.
4. When the browser exits (Alt+F4), it stops the server.

The README covers disabling the OS screensaver/suspend and checking free disk space (about 1.2 GB per hour of footage).

## Verification
1. `npm start`, then smoke-test the API with curl: create a session, post a couple of dummy chunks, end the clip and the session. Check the folder layout, `session.json` and the `index.csv` row.
2. Set `questionMix: {funny: 1, last: 1}, maxSecondsPerQuestion: 8` in config. Then drive headless Chrome over CDP with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` and run through:
   - one question ended with Next
   - one question ended by the timer
   - Escape on a second session
3. Play the resulting clips in VLC, checking that video and audio are there and in sync, and that each clip matches its question. Confirm that timestamps and `endedBy` in `session.json` are correct and that the app returns to START by itself.
4. Kill the server mid-clip and confirm the partial file is still playable up to its last chunk.
5. Restore the config defaults.
