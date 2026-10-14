# Confession booth

A webcam confession booth for a birthday weekend, styled like a reality TV talking head. Guests type their names, then answer a few random questions on camera. They see themselves full screen with a name tag in the lower third, and each question appears at the top, just under the webcam. Each answer is saved as its own video clip, with a record of who answered what, ready to cut into a compilation afterwards.

It runs on one computer (Linux or Windows): a small Node server writes the recordings to disk, and Chrome shows the booth full-screen.

## You'll need

- [Node.js](https://nodejs.org) 20 or newer
- Google Chrome (or Microsoft Edge on Windows)
- A webcam and microphone
- [ffmpeg](https://ffmpeg.org), only for preparing the clips after the weekend

There are no npm packages to install.

## Running the booth

- **Linux:** `npm run booth`
- **Windows:** double-click `start-booth.cmd`

This starts the server and opens the booth full-screen in kiosk mode. It uses its own browser profile (`.booth-browser-profile/`) where camera and microphone access is allowed automatically. If the server crashes it restarts by itself. Press **Alt+F4** to close the booth window, which also stops the server.

To run just the server, use `npm start` and open http://localhost:3000 in Chrome.

## How guests use it

1. Type a name (or a few names) and press Enter. Then add a one-line tagline for the name tag, such as "Jo's oldest friend, allegedly", or leave it blank. Press Enter again or click **Roll camera**.
2. After a 3-2-1 countdown, the first question appears and recording starts.
3. Click **Next question**, or press Space, Enter or →. Each question also moves on by itself after `maxSecondsPerQuestion`.
4. After the last question, a "That's a wrap" screen holds a freeze frame of the guest's last second, then the booth resets for the next guest.

**Esc** ends the session early, which is handy if someone starts by accident.

## Settings

Open http://localhost:3000/settings, or press **Ctrl+,** on the booth's start screen. The shortcut is the way in from kiosk mode, where there's no address bar. The settings page has:

- the camera and microphone, with a live preview and a level meter for the mic
- the birthday person's name, the number of questions and the timings
- the video quality
- the questions themselves

Press **Save changes** (or Ctrl+S), then **Back to booth**. The booth reloads with the new settings.

The page saves to `config.json` and `questions.txt`, which you can also edit by hand:

| Setting | Default | What it does |
|---|---|---|
| `birthdayName` | `"the birthday person"` | Replaces `{birthday}` in the questions, and shows in the top corner as "Jo · The Weekend" |
| `questionsPerSession` | `5` | Questions per guest, picked at random from `questions.txt` |
| `maxSecondsPerQuestion` | `90` | Time limit per question before it moves on by itself |
| `countdownSeconds` | `3` | Countdown before the first question |
| `thankYouSeconds` | `10` | How long the "That's a wrap" screen stays up |
| `videoBitsPerSecond` | `2500000` | Video quality. 2.5 Mbps is about 1.2 GB per hour of footage |
| `cameraName` / `microphoneName` | `""` | Part of a device name to use instead of the system default, e.g. `"C920"`. The settings page saves the full name |
| `host` / `port` | `127.0.0.1` / `3000` | Where the server listens |
| `recordingsDir` | `"recordings"` | Where clips are saved |

Add questions to `questions.txt`, one per line. Lines starting with `#` are ignored.

Both files are re-read for every new guest, so you can change them while the booth is running. A new camera or mic takes effect when the booth reloads, which it does after every guest (or press F5). The exceptions are `host`, `port` and `recordingsDir`, which need a restart. They aren't on the settings page.

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

- **`session.json`** records the names and tagline, plus each question with its start and end times, the duration, and how it ended: `next`, `timer` or `escape`.
- **`index.csv`** opens in Excel or a spreadsheet app. Sort it by question to build "everyone answers X" montages. The `tagline` column has what each guest typed for their name tag, ready for lower thirds in the edit.

Video is uploaded in 2-second chunks while recording. If the browser or computer crashes, you lose at most the last couple of seconds.

## After the weekend

```
npm run prep
```

This converts every clip into a constant-frame-rate H.264/AAC MP4 in `recordings-for-edit/`, with the same folder layout, `session.json` files and `index.csv`. Browser recordings use a variable frame rate, which Premiere and DaVinci Resolve can mishandle: audio drifts out of sync on the timeline. Edit from `recordings-for-edit/`, not `recordings/`. If you run it again, it skips clips that are already converted.

## Before the party

- Set the mic level. Open the input settings: on Ubuntu, Settings → Sound → Input; on Windows, Settings → System → Sound → Input.
  - With nobody talking, the level meter should stay low. If fan or room noise alone fills it, turn the input volume down.
  - Then talk from where guests will stand. The meter should move clearly with your voice.
  - The booth never changes this level itself.
  - The level meter on the settings page shows what the booth will record, so check it there too.
- If you can, use an external USB mic or a webcam with a built-in mic. A laptop's internal mic sits right next to the fan.
- Do a full test session, then play the clips back with sound.
- Turn off screen blanking, sleep and automatic updates/restarts, and keep the computer plugged in.
- Check free disk space. Plan for about 1.2 GB per hour of answers.
- Light the guests' faces: a lamp behind the screen pointing at them makes a big difference.
- Optional, Linux only: fix the webcam's exposure and focus so it doesn't hunt in dim light. Run `v4l2-ctl -d /dev/video0 --list-ctrls` to see what your camera supports.

## Troubleshooting

- **"The camera is being used by another app"**: close Zoom, Teams, OBS and similar apps, then press Try again.
- **Recordings are mostly hiss, or voices are faint or missing**: the system mic level is wrong, usually far too high, so noise drowns out the voice. Set it as described under "Before the party".
- **Wrong camera or microphone**: press Ctrl+, in the booth (or **Settings** on the error screen), pick the right one, save, then go back to the booth.
- **"Something is already running at http://127.0.0.1:3000"**: the booth (or something else) is already using that port. Close the other booth window, or change `port`.
