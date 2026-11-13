# Confession booth

A webcam confession booth for a birthday weekend, styled like a reality TV talking head. Guests type their names, then answer a few random questions on camera, in French or English. They see themselves full screen with a name tag in the lower third, and each question appears at the top, just under the webcam. Each answer is saved as its own video clip, with a record of who answered what, ready to cut into a compilation afterwards.

It runs on one computer (Linux or Windows): a small Node server writes the recordings to disk, and Chrome shows the booth full-screen.

## You'll need

- [Node.js](https://nodejs.org) 20 or newer (22 or newer to make the film)
- Google Chrome (or Microsoft Edge on Windows)
- A webcam and microphone
- [ffmpeg](https://ffmpeg.org), only for making the film after the weekend

There are no npm packages to install.

## Running the booth

- **Linux:** `npm run booth`
- **Windows:** double-click `start-booth.cmd`

This starts the server and opens the booth full-screen in kiosk mode. It uses its own browser profile (`.booth-browser-profile/`) where camera and microphone access is allowed automatically. If the server crashes it restarts by itself. Press **Alt+F4** to close the booth window, which also stops the server.

To run just the server, use `npm start` and open http://localhost:3000 in Chrome.

## How guests use it

1. The booth starts in French. English speakers click **English** in the top corner; the next guest starts in French again.
2. Type a name (or a few names) and press Enter. Then add a one-line tagline for the name tag, such as "Jo's oldest friend, allegedly", or leave it blank. Press Enter again or click **Moteur** (**Roll camera** in English).
3. After a 3-2-1 countdown, the first question appears in their language and recording starts.
4. Click **Question suivante** (**Next question**), or press Space, Enter or →. Each question also moves on by itself after `maxSecondsPerQuestion`.
5. After the last question, a "C'est dans la boîte" ("That's a wrap") screen holds a freeze frame of the guest's last second, then the booth resets for the next guest.

**Esc** ends the session early, which is handy if someone starts by accident.

## Settings

Open http://localhost:3000/settings, or press **Ctrl+,** on the booth's start screen. The shortcut is the way in from kiosk mode, where there's no address bar. The settings page has:

- the camera and microphone, with a live preview and a level meter for the mic
- the birthday person's name, how many funny, cute and closing questions each guest gets, and the timings
- the video quality
- the questions themselves

Press **Save changes** (or Ctrl+S), then **Back to booth**. The booth reloads with the new settings.

The page saves to `config.json` and `questions.txt`, which you can also edit by hand:

| Setting | Default | What it does |
|---|---|---|
| `birthdayName` | `"the birthday person"` | Replaces `{birthday}` in the questions, and shows in the top corner as "Jo · Le Week-end" |
| `languages` | `["fr", "en"]` | The languages guests can pick, in the order of the columns in `questions.txt`. The first is the default and names the show. Use `["fr"]` for a French-only booth, with no language switch |
| `questionMix` | `{"funny": 3, "cute": 1, "last": 1}` | How many questions each guest gets from each section of `questions.txt` (see below) |
| `maxSecondsPerQuestion` | `90` | Time limit per question before it moves on by itself |
| `countdownSeconds` | `3` | Countdown before the first question |
| `thankYouSeconds` | `10` | How long the "That's a wrap" screen stays up |
| `videoBitsPerSecond` | `2500000` | Video quality. 2.5 Mbps is about 1.2 GB per hour of footage |
| `cameraName` / `microphoneName` | `""` | Part of a device name to use instead of the system default, e.g. `"C920"`. The settings page saves the full name |
| `host` / `port` | `127.0.0.1` / `3000` | Where the server listens |
| `recordingsDir` | `"recordings"` | Where clips are saved |

Add questions to `questions.txt`, one per line, in French then English with a `|` between them:

```
Quel est le pire cadeau que tu aies jamais offert ? | What's the worst gift you've ever given anyone?
```

- Guests only get questions in the language they picked. A line with no `|` is only asked in French, and a line starting with `|` only in English. The settings page says how many questions each language has.
- The English doesn't have to be a translation. Where a joke or pun doesn't carry over, put a different question that works in English.
- Write the French for *tu*, with an ordinary space before `?`, `!`, `:` and `;`. The booth swaps in the narrow no-break space French uses, so a `?` never wraps onto a line of its own.
- If the birthday name starts with a vowel, "de {birthday}" and "que {birthday}" become "d'Anne" and "qu'Anne" by themselves.
- The booth's own text, like the buttons, the start screen and the film's titles, is in `public/strings.js`, with French and English side by side.

Lines starting with `#` are ignored. The `[funny]`, `[cute]` and `[last]` lines split the questions into sections, and `questionMix` sets how many each guest gets from each:

- `[funny]` and `[cute]` questions are picked at random and shuffled together. Questions above the first section line count as `[funny]`.
- A `[last]` question always comes last. They're for saying something nice about the birthday person, to end each guest's session on a sincere note.
- When the birthday person is in the booth, questions with `{birthday}` in them are skipped, so nobody asks them to describe themselves in three words. The booth spots them by name: a name (or one of the names in a group, like "Sam & Jo") that matches `birthdayName`, ignoring case and accents. A surname after it still counts.
- If a section runs short, for example for the birthday person, the gaps are filled from the other `[funny]` and `[cute]` questions, so everyone still gets the full number. If a section in `questionMix` has no questions at all, the server logs a warning.

Both files are re-read for every new guest, so you can change them while the booth is running. A new camera or mic takes effect when the booth reloads, which it does after every guest (or press F5). The exceptions are `host`, `port` and `recordingsDir`, which need a restart. They and `languages` aren't on the settings page.

Anyone who can open the booth's address can change its settings. With the default `host` of `127.0.0.1`, that's only this computer.

## What gets saved

```
recordings/
  index.csv                                   one row per clip, across all sessions
  2026-10-11_14-23-05_sam-and-alex/
    session.json                              names, tagline, questions, timings
    01-describe-the-birthday-person-in-three.mp4
    02-whats-the-worst-gift-youve-ever-given.mp4
    ...
```

- **`session.json`** records the names, tagline and language, plus each question as asked and in every language, with its section, start and end times, the duration, and how it ended: `next`, `timer` or `escape`.
- **`index.csv`** opens in Excel or a spreadsheet app. The `question` column has the question as the guest was asked it, and `question_all_languages` has the whole line, French and English. Sort by `question_all_languages` to build "everyone answers X" montages, with French and English answers to the same question together. The `language` column says which language each guest picked. The `tagline` column has what each guest typed for their name tag, ready for lower thirds in the edit. Filter the `section` column to `last` to find every guest's nice message for the end of the film.

Video is uploaded in 2-second chunks while recording. If the browser or computer crashes, you lose at most the last couple of seconds.

## Making the film

The film is made in one command, from a spreadsheet where you pick the clips. It looks like an episode of the show:

- Opening titles: "Jo · Le Week-end" over a wall of guests' faces.
- A question card whenever the question changes, with the question in French and, underneath, in English. The film's other text is in both languages too, like "On a demandé · We asked". Answers stay in whatever language they were recorded in.
- Each answer with the guest's name tag and the show title burned in, exactly as the booth showed them.
- A "Joyeux anniversaire, Jo." freeze frame with "Happy birthday, Jo." under it, then credits listing everyone in the film.

Every answer's volume is levelled, so quiet and loud guests sound alike. The film has chapters for each question, so you can skip ahead in VLC.

1. Run `npm run compile`. The first time, it creates `compilation/running-order.csv` with one row per clip.
2. Open it in a spreadsheet app, and watch the clips in `recordings/`. The `file` column says which is which.
3. Number the clips you want in the `order` column: 1, 2, 3… Clips without a number are left out. Use decimals, like 2.5, to slot a clip in between without renumbering.
4. Save it as CSV, then run `npm run compile` again. The film is saved as `compilation/jo-le-week-end.mp4`.

The other columns you can change:

| Column | What it does |
|---|---|
| `start` / `end` | Trim the clip, in seconds from its start, like `3` or `12.5` (or `1:05`). Most answers start with a few seconds of the guest reading the question, so trimming `start` makes the film much snappier. |
| `name` / `tagline` | What the name tag says. Fix typos or capitals here. |
| `card` | The question card shown before the clip, in each language with `\|` between them, as in `questions.txt`. The first is shown big and the others underneath. Clear it for no card. Consecutive clips with the same card share one, so to build an "everyone answers X" montage, number those clips one after the other. French and English answers to the same question have the same card. You can also put different words on the card than the guest was asked… |

To add a chapter heading, like "Et maintenant… les toasts | And now… the toasts", add a row with just an `order` and a `card`. You can also add your own videos, like phone footage from the weekend, by adding a row with a `file` path (relative to `recordings/`, or a full path).

Run `npm run compile` as often as you like. Each piece is rendered once and kept in `compilation/cache/`, so after you change the order or a trim, only the changed pieces are redone. Clips recorded after the spreadsheet was made are added to the bottom, and nothing you've typed is lost. To skip a clip, leave its `order` empty rather than deleting the row, because deleted rows come back at the bottom. Delete `compilation/cache/` to free up disk space once the film is done.

`npm run compile -- --all` makes a film of every clip in spreadsheet order, ignoring `order`. It's a quick way to check the titles and the look.

Settings, in the `compilation` section of `config.json`:

| Setting | Default | What it does |
|---|---|---|
| `introMusic` | `""` | An audio file (path relative to this folder) to play under the opening titles |
| `outroMusic` | `""` | An audio file to play under the ending and credits |
| `introVideo` | `""` | A ready-made intro video to use instead of the generated titles |
| `outroTitle` | `"Joyeux anniversaire,\n{birthday}. \| Happy birthday,\n{birthday}."` | The ending's title, in each language with `\|` between them. The first is big and the others go underneath. `\n` starts a new line |
| `outroNote` | `"Avec l'amour de tous ceux… \| Love from everyone…"` | The lines under it, one per language |
| `lowerThirdSeconds` | `6` | How long the name tag stays up at the start of each answer |
| `normalizeAudio` | `true` | Level every answer's volume |

On a recent laptop, rendering takes about 40% of the film's length: a 15-minute film takes about 6 minutes the first time.

### Editing by hand instead

```
npm run prep
```

This converts every clip into a constant-frame-rate H.264/AAC MP4 in `recordings-for-edit/`, with the same folder layout, `session.json` files and `index.csv`. Browser recordings use a variable frame rate, which Premiere and DaVinci Resolve can mishandle: audio drifts out of sync on the timeline. Edit from `recordings-for-edit/`, not `recordings/`. If you run it again, it skips clips that are already converted. You don't need this for `npm run compile`, which reads `recordings/` directly.

## Before the party

- Set the mic level. Open the input settings: on Ubuntu, Settings → Sound → Input; on Windows, Settings → System → Sound → Input.
  - With nobody talking, the level meter should stay low. If fan or room noise alone fills it, turn the input volume down.
  - Then talk from where guests will stand. The meter should move clearly with your voice.
  - The booth never changes this level itself.
  - The level meter on the settings page shows what the booth will record, so check it there too.
- If you can, use an external USB mic or a webcam with a built-in mic. A laptop's internal mic sits right next to the fan.
- Do a full test session, then play the clips back with sound.
- Set `birthdayName` in `config.json`, then run `npm run compile -- --all` to see the film's titles and graphics with your test clips. Pick the intro and outro music now, not on Sunday night.
- Then delete the test sessions and `compilation/`, so the test clips don't end up in the film.
- Turn off screen blanking, sleep and automatic updates/restarts, and keep the computer plugged in.
- Check free disk space. Plan for about 1.2 GB per hour of answers.
- Light the guests' faces: a lamp behind the screen pointing at them makes a big difference.
- Optional, Linux only: fix the webcam's exposure and focus so it doesn't hunt in dim light. Run `v4l2-ctl -d /dev/video0 --list-ctrls` to see what your camera supports.

## Troubleshooting

- **"The camera is being used by another app"**: close Zoom, Teams, OBS and similar apps, then press Try again.
- **Recordings are mostly hiss, or voices are faint or missing**: the system mic level is wrong, usually far too high, so noise drowns out the voice. Set it as described under "Before the party".
- **Wrong camera or microphone**: press Ctrl+, in the booth (or **Settings** on the error screen), pick the right one, save, then go back to the booth.
- **"Something is already running at http://127.0.0.1:3000"**: the booth (or something else) is already using that port. Close the other booth window, or change `port`.
