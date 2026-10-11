# Easter egg ideas

The booth is styled as a reality TV talking head: full-screen camera, the question in a strip at the top, a lower-third name tag, a REC bug, and a "That's a wrap" freeze frame. The ideas below are fitted to that design. Ideas from the earlier church confessional look have been reworked for reality TV.

## Before building any of them

- **The clips record only the camera, not the screen.** In the compilation you'll see someone flinch or squint with no clue why. Have the booth log each easter egg in `session.json` with a time from the start of the clip (e.g. `{"egg": "jumpscare", "at": 14.2}`). Then you can recreate it as an overlay at the right frame when editing.
- **Put things to read in the strip, and surprises everywhere else.** The question strip sits just under the webcam, so guests look near the lens while reading. Anything meant to catch them off guard should go in the lower third, the bug or a corner. The glance away then reads as a reaction on camera.
- **The preview is mirrored with `transform: scaleX(-1)`.** Effects on `#preview` must use the separate `rotate`, `scale` and `translate` properties, or `filter`. Setting `transform` would undo the mirror.
- **Sound works in the kiosk.** `start-booth.js` launches Chrome with `--autoplay-policy=no-user-gesture-required`. In ordinary Chrome (`npm start`), sounds only play after the guest presses a key.

## Where each idea hooks in

| On screen | Element | Ideas |
|---|---|---|
| Strip label ("Question 2 of 5") | `#question-progress` | Producer's notes, Previously on…, Hot seat |
| Strip text | `#question-text` | Question switch, Bleeped question, tiny text before a scare |
| Lower third | `#lower-name`, `#lower-tagline` | Tagline twist, Silence watcher, Behind you, The star walks in |
| Bug, top right | `#rec-badge`, `#show-title` | You're live, After Dark |
| Full-screen preview | `#preview` | Drunk mode, Dramatic zoom |
| Wrap screen | `#thanks-title`, `#thanks-note`, `#freeze-frame` | Next time on…, Secret task, Fake cut, One more take |

## Original three, in the new design

### Question switch (the villain edit)

Ask one question in the booth, then show a different one in the edit, so the answer looks bad. Misleading edits are what reality TV is famous for, so this suits the new look.

- The fake question has to get a short answer that doesn't repeat the question. "What's your favourite vegetable?" gets "My favourite vegetable is…", which gives the game away. "Name a vegetable" just gets "Broccoli."
- Don't add a general "answer in a full sentence" instruction anywhere. Real producers ask for that so clips stand alone, but it breaks the switch.
- Pairs that work (what they're asked → what the edit shows):
  - "What noise does a goat make? Just the noise." → "What does {birthday} sound like first thing in the morning?"
  - "Rate pineapple on pizza out of 10." → "Rate {birthday}'s dancing out of 10."
  - "Describe the texture of cold porridge." → "Describe {birthday}'s cooking."
  - "How many hours of sleep do you need?" → "How many drinks has {birthday} had tonight?"
  - "Show us your best evil laugh." → "What was your reaction when you got the invite for this weekend?"
- To set it up: use a format in `questions.txt` like `Rate pineapple on pizza out of 10. => Rate {birthday}'s dancing out of 10.`
  - `readQuestions` in `server.js` splits the line. Guests see only the left side, which also names the clip file.
  - The right side goes on the clip in `session.json` as `editQuestion`. Clips are created in `server.js` around line 282.
  - It also goes in a new last column of `index.csv`, after `tagline`, so older rows still line up.

### Jump scare

Show something scary on screen during a question and catch the reaction.

- The strip is right under the webcam, so tiny text there makes guests lean into the lens. When the scare lands, their face fills the frame.
- Make it random (say, 1 in 4 sessions). By day two everyone will have heard about it.
- Fire it about 5 seconds into their answer, mid-sentence, not when the question appears. Add a loud sound, because most of the scare is in the audio.
- Reality TV versions that don't need a scary image:
  - **You're live:** the REC bug flips to "● LIVE · kitchen TV". Instant panic about what they've just said.
  - **Behind you:** the lower third changes to "{birthday}, standing right behind you." They turn around.
- For a classic scare, cover the preview with an extreme close-up of the birthday person's face.

### Drunk mode

Blurred, moving text or other effects that make the question hard to read and answer.

- The preview now fills the screen, so making it sway moves the whole picture. That's much stronger than wobbling the text alone.
- Blur and wobble the strip text as well, and pair it with a tongue twister or "Spell {birthday}'s full name backwards."
- Make it more likely during After Dark (see below).

## New ideas

### Using what the booth already records

`index.csv` gets every guest's name, tagline and questions at the end of each session. The server can read it when a new session starts.

- **Previously on…:** when a name has been in before, the label reads "Previously on {birthday} · The Weekend" and the question picks up their last visit: "Four hours ago you told us your pettiest grudge. Any updates?"
- **Producer's note (accusations):** the label switches to "Producer's note" and the strip reads "Alex says you still owe them a tenner. Respond." Take the name from an earlier session, never the current guest. This is exactly how reality TV producers stir up drama.
- **The star walks in:** when the name matches `birthdayName`, fill a blank tagline with "The star of the show" and use special questions: "What do you think everyone has been saying about you in here?" Cut it together with what people actually said.

### Live tricks

- **Tagline twist:** halfway through an answer, the guest's own tagline changes to a judgy caption: "Definitely lying." "Has clearly rehearsed this." "Still talking." They watch their own name tag turn on them. Log it so the edit can make the same swap.
- **Producer's interruption:** about 15 seconds into an answer, the label flips to "Producer's note" and the strip reads "Again, but angrier." or "Can you look less guilty?"
- **Dramatic zoom:** on a juicy question, slowly zoom the preview into their face with a "dun dun DUN" sting. Use the `scale` property so the mirror stays.
- **Lie detector:** a needle gauge low on the right, near the timer line, that jiggles while they talk. Every so often it slams to "LIE DETECTED" with a buzzer. It sits away from the lens, so a glance down at it looks guilty.
- **Hidden remote:** trigger a buzzer, a gasp, an "ooooh", a record scratch, "dun dun DUN", a bleep, the lie detector or the jump scare from across the room.
  - **Check which keys it sends first.** During a question, Space, Enter and → skip to the next question, and Esc ends the session. Many presentation clickers send → for "next slide", and some send Esc or F5.
  - Use one that sends PageUp/PageDown, or a cheap wireless number pad, and map those keys instead.
- **Bleeped question:** "What's the most ███ thing you've ever done with ███?" in TV censor bars, with a bleep sound when it appears. Guests fill in the blanks themselves.
- **Silence watcher:** the mic is already open, so the page can tell when nobody has spoken for 5 seconds. Then the tagline changes to "Has nothing to say."
- **Hot seat:** the start screen already asks "Who's in the hot seat?" For one round, flash the screen red with "HOT SEAT" in the label, then fire three 10-second questions. In a dim room the screen lights their face, so the red flash shows in the footage itself.

### Endings, on the wrap screen

The wrap screen shows "That's a wrap, Sam." over a greyscale freeze frame of the guest's last second.

- **Next time on…:** add a teaser under the title: "Next time on {birthday} · The Weekend: Sam finally tells the truth about Ibiza." Pick from a list of dramatic lines, or build one from a question they just answered. It fits the freeze frame perfectly.
- **Secret task:** the wrap gives them a Big Brother style mission: "Your secret task: get {birthday} to say 'banana' before midnight. Report back to the booth." On their next visit, Previously on… asks whether they managed it. Show it for longer than the usual 10 seconds so there's time to read it.
- **Fake cut:** "Want any of that cut from the episode? Press C." Any key gets "The producers have overruled you." (If someone really means it, delete the clip later.)
- **One more take:** just as the wrap appears, the booth snaps back: "Sorry, one pickup. Say '{birthday} is my best friend' like you hate them." Recording currently stops after the last question, so this needs one extra hidden clip, added to the session when it starts.

### Hidden in the booth

- **After Dark:** after midnight, or when someone types a password such as "uncut" as their tagline, the bug changes to "{birthday} · After Dark". The questions come from a spicier `questions-after-dark.txt`, and drunk mode turns up more often. Let the password spread by word of mouth over the weekend.
- **Nominations:** names with "&" get "On 3, point at who you're nominating for eviction. 3, 2, 1." Everyone pointing at once looks great on video.

### Secret supercut

An easter egg for the birthday person, not the guests.

- Every guest gets the same line without knowing the others did: "Say 'I'm not here to make friends.' Mean it." Or: "Say {birthday}'s name like you've just found out they betrayed you." `index.csv` already sorts by question, so the montage almost edits itself.

## If you only build a few

Build the question switch, the tagline twist, producer's notes (accusations and interruptions), and Next time on…. All four reuse elements already on screen: the strip label, the strip text, the lower third and the wrap screen. They're mostly text swaps on timers. Only the question switch and the accusations need small server changes.
