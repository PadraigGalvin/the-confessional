# Confession Booth: Plan

## Context
This is a single-machine "confession booth" for a birthday weekend. Guests enter their names, then answer a few randomly chosen questions on camera. Each answer is saved as its own video clip with metadata, so the clips can be edited into a funny compilation afterwards. The booth runs unattended for days, so it has to be reliable and recover by itself.

The booth must run on either Linux or Windows. Dev machine: Node 24, Google Chrome 155, webcam at `/dev/video0`, ffmpeg 8.

**Decisions made with the user:** one clip per question; a Next button plus a max timer per question; N random questions per session drawn from a pool; keyboard and mouse input. Guests are mostly French speakers, but some only speak English, so the booth is bilingual: French by default, with an English switch on the start screen, informal *tu*, and a film with its text in both languages.

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
    app.js              # state machine + recorder + chunk upload queue + language switch
    strings.js          # every piece of guest-facing and film text, in French and English (shared with server and compile)
    media.js            # getUserMedia constraints, device matching, camera error messages (shared)
    settings.html/.css/.js  # /settings: edit config.json + questions.txt, camera preview, mic level meter
    fonts/              # Barlow + Barlow Condensed (bundled so the booth works offline)
  scripts/
    start-booth.js      # start + supervise server, then Chrome/Edge kiosk with dedicated profile
    prep-for-edit.js    # post-weekend: ffmpeg batch-transcode to constant-frame-rate H.264/AAC MP4
    compile.js          # post-weekend: running order spreadsheet -> finished film (see below)
    graphics/graphics.html  # the film's graphics, drawn with public/style.css
    lib/                # find-browser (shared with start-booth), headless-Chrome graphics, CSV
  start-booth.cmd       # Windows double-click launcher
  recordings/           # output (created at runtime, gitignored)
  compilation/          # running-order.csv, render cache and the finished film (gitignored)
  README.md             # setup + running notes
```

The helper scripts are Node rather than bash, so the same scripts run on Windows.

`config.json` defaults: `birthdayName: "the birthday person"` (fills `{birthday}` in questions), `languages: ["fr", "en"]` (the languages guests can pick, in `questions.txt` column order; the first is the default and names the show), `questionMix: {funny: 3, cute: 1, last: 1}` (questions per guest from each section of `questions.txt`), `maxSecondsPerQuestion: 90`, `countdownSeconds: 3`, `thankYouSeconds: 10`, `videoBitsPerSecond: 2500000`, `cameraName`/`microphoneName: ""` (label substring to pick a device), `host: "127.0.0.1"`, `port: 3000`, `recordingsDir: "recordings"`.

## Server (`server.js`)
- Static file serving from `public/` with a small MIME map.
- `POST /api/session` `{name, tagline?, language?}` re-reads `questions.txt` on every call, so questions can be edited mid-weekend without a restart. An unknown or missing `language` falls back to the first in `languages`. It then:
  - picks questions per `questionMix` at random (Fisher–Yates), from the ones with a version in the guest's language: `[funny]` and `[cute]` shuffled together, then a `[last]` one (something nice about the birthday person). If a name in the name box matches `birthdayName`, questions with `{birthday}` are skipped, and short sections are topped up from the other `[funny]`/`[cute]` leftovers
  - fills in `{birthday}` (with French elision: "d'Anne", "qu'Anne") and adds French typography (a narrow no-break space before `? ! : ;` and inside « ») to French questions
  - creates `recordings/2026-10-11_14-23-05_sam-and-alex/`
  - writes the initial `session.json`
  - returns `{sessionId, questions, settings}`, with the questions in the guest's language
- `POST /api/session/:id/clip/:n/chunk?seq=K` takes the raw request body (with the recorder's MIME type as `Content-Type`) and appends it to `NN-<question-slug>.<ext>`. `seq` makes retries safe: a chunk that's already written is acknowledged without being appended again, and a gap gets a 409.
- All disk writes for a session go through one per-session promise queue, and `session.json` is written atomically (temp file + rename).
- `POST /api/session/:id/clip/:n/end` `{startedAt, endedAt, endedBy: "next"|"timer"|"escape"}` updates the clip entry in `session.json`.
- `POST /api/session/:id/end` `{status: "completed"|"ended-early"}` sets `endedAt` and `status`, and appends one row per clip to `recordings/index.csv` (session dir, name, question #, question, file, duration, endedBy, recorded at, tagline, section, language, question_all_languages). `question_all_languages` is the whole "Français | English" line, so French and English answers to the same question sort together. This CSV gives one overview across all sessions for building "everyone answers question X" montages.
- `GET /settings` serves the settings page. `PUT /api/settings` validates the guest-facing settings (ranges, lengths, and the `funny`/`cute`/`last` counts in `questionMix`) and rewrites `config.json` atomically, keeping any other `questionMix` sections added by hand; `GET`/`PUT /api/questions` reads and writes the raw `questions.txt`. Writes use PUT, so a page on another site can't send them without a CORS preflight, which the server never grants.
- **Safety:** active sessions live in an in-memory Map, and an unknown `sessionId` gets a 404. `:n` must be an integer in range. Names and questions are slugified (lowercase, `[a-z0-9-]`, max ~40 chars) before they're used in paths. Request bodies are size-capped per chunk.
- `session.json` shape: `{name, tagline, language, startedAt, endedAt, status, mimeType, clips: [{index, question, questionByLanguage: {fr, en}, section, file, startedAt, endedAt, durationSec, endedBy}]}`.

## Languages
- **Questions:** each line of `questions.txt` is `Français | English`, columns in `languages` order. A language with an empty column doesn't get that question, so a line with no `|` is French-only. The English can be a substitute rather than a translation where wordplay doesn't carry over. `parseQuestions` is mirrored by `countQuestions` in `settings.js`, which reports how many questions each language has.
- **Booth text:** `public/strings.js` holds `{fr, en}` dictionaries. Text with numbers is a function, because French plurals differ (0 and 1 are singular). French strings go through `typeset()` automatically. Static elements in `index.html` carry `data-text` / `data-text-placeholder` / `data-text-aria-label` keys, and `setLanguage()` fills them and sets `<html lang>`.
- **Switch:** one button per language, top right on the start screen, each named in its own language. The choice is just a variable: the page reloads after every guest, so each guest starts in the default language. The buttons cancel `mousedown` so the cursor stays in the name tag.
- **Show name:** always in the first language ("Jo · Le Week-end"), in the booth and the film, since it's the show's name.

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

## Compilation film (`scripts/compile.js`)
Goal: at the end of the weekend, the film is one spreadsheet edit and one command away.

- **Languages:** the film's fixed text is in every language, joined with " · " ("On a demandé · We asked"). A `card` (and `outroTitle`/`outroNote`) holds a version per language separated by `|`: the first is drawn big and the rest underneath. New rows' cards default to `question_all_languages`, so consecutive French and English answers to the same question share one card. Dates use the first language's locale.
- **Running order:** `compilation/running-order.csv` is made from `index.csv` on the first run. On later runs, newly recorded clips are appended and everything already there is left alone. The file is only rewritten when clips are added, and a write failure (the file open in Excel) is a warning, not an error. Editable columns are `order` (any numbers, decimals to slot in between), `start`/`end` (seconds or m:ss), `name`, `tagline` and `card`, followed by read-only info columns. Clips are matched by `file`, columns by header name, so the easter-egg branch's extra `section` column is carried along. Rows with only a `card` are chapter headings. Parsing copes with how spreadsheet apps re-save CSV: semicolons, decimal commas, a BOM, CRLF line endings and unquoted fields.
- **Film structure:** opening titles (the show name over a mosaic of guests' faces, with the title sliding in), then each chosen clip in order. A question card plays whenever the `card` text changes. Each answer has the bug and the lower-third name tag, which fades out after `lowerThirdSeconds` and is skipped when the same guest answers again straight after. The film ends with a booth-style wrap freeze frame ("Happy birthday, Jo.") and a "Starring" credits card. Chapters are written for every card.
- **Graphics:** `graphics.html` links `public/theme.css` and `public/style.css` and reuses the booth's markup and ids, so the name tag and wrap screen are pixel-identical to the booth. Headless Chrome renders each graphic at 1920×1080 (`--u` = 1vw scales exactly) over a transparent background. It's driven over CDP with Node's built-in WebSocket (Node 22+), so there are no dependencies. Puppeteer was rejected because it needs npm. ffmpeg `drawtext`/ASS were rejected because matching the look and text wrapping would be fiddly.
- **Rendering:** each piece (card, answer, title) is its own MP4 with identical encoding settings: 1080p30, libx264 veryfast CRF 18, AAC 48 kHz stereo. Pieces are joined with the concat demuxer, copying the video and re-encoding the audio. Answers are read straight from `recordings/` (VFR is fixed by `fps=30` + `aresample=async=1`), trimmed and fitted to 16:9. Audio is levelled with two-pass `loudnorm` to -16 LUFS, because test clips differed by 16 dB. Graphics are held with the `loop` filter rather than `-loop 1`, which re-decodes the PNG every frame.
- **Cache:** pieces, stills and graphics are named by a hash of their inputs (file size and mtime, trim, text, `graphics.html` + `theme.css` + `style.css`, encoder settings, `RENDER_VERSION`). A re-run after reordering only re-joins the pieces, which takes seconds.
- **Optional assets** (in `config.json` → `compilation`): `introVideo` replaces the generated titles; `introMusic` plays under the titles, and `outroMusic` plays under the wrap and credits.

## Verification
1. `npm start`, then smoke-test the API with curl: create a session, post a couple of dummy chunks, end the clip and the session. Check the folder layout, `session.json` and the `index.csv` row.
2. Set `questionMix: {funny: 1, last: 1}, maxSecondsPerQuestion: 8` in config. Then drive headless Chrome over CDP with `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream` and run through:
   - one question ended with Next
   - one question ended by the timer
   - Escape on a second session
3. Play the resulting clips in VLC, checking that video and audio are there and in sync, and that each clip matches its question. Confirm that timestamps and `endedBy` in `session.json` are correct and that the app returns to START by itself.
4. Kill the server mid-clip and confirm the partial file is still playable up to its last chunk.
5. Restore the config defaults.
