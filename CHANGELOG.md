# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.0-beta.1] — 2026-08-11

First beta of the multi-character release.

### Added
- **Multi-character support** — Yoshimitsu ships alongside Jin
  (`data/yoshimitsu.json`, 312 moves), with a character picker in settings
  that live-swaps the recognizer, trainer, and move browser. Fetch any other
  character with `npm run fetch-data <Name>` (`scripts/fetch-character.mjs`
  replaces the Jin-only fetch script).
- Notation compiler understands arbitrary stance prefixes (`KIN.`, `NSS.`,
  `FLE.`, ...), the `hFC.` half-crouch prefix, `qcf` motions, mash-count
  (`*(n)`) and held-input (`*`) markers, and mid-string stance segments like
  `2,NSS.1`.
- Stance transitions are now derived from wavu's recovery field ("r15 KIN")
  and notes for whatever stances a character actually has — stance moves that
  keep you in the stance (e.g. Flea) chain correctly. `data/stances.json` is
  now just curated overrides.
- Per-character training combos in `data/combos.json`, including three
  Yoshimitsu starters (Flash drill, NSS Flash setup, Manji spin lows).

### Fixed
- **Consistent input grading** — a direction and button pressed
  "simultaneously" arrive as two XInput packets a few ms apart in arbitrary
  order; grading used the direction from the button's packet, so whether
  `df+2` counted as `df+2` or plain `2` was a coin flip. The direction is now
  re-checked at the end of the one-frame chord window: a direction landing
  just after the button counts, while releasing one just after the button
  doesn't retract it (a quick roll-off after `uf+4` still grades as `uf+4`).
- Held presses are recognized immediately — recognition no longer waits for
  the next controller packet (previously a pressed-and-held button wasn't
  recognized until release or movement).
- Notation drill: retrying during the "wrong" reveal no longer silently eats
  the first press (which misaligned grading of the following inputs) — a
  press after a 300 ms grace ends the reveal and is graded as the retry.
- Combo trainer: a wrong opener button is now flagged instead of being
  silently ignored, and a leftover result-clear timer from the previous
  attempt can no longer wipe verdicts mid-attempt.
- Wavu ids with HTML-entity-encoded just-frame colons (Yoshimitsu's
  `f,F+2:2`) are decoded correctly by the fetch script.
- `qcb`/`qcf` expansion no longer emits a stray `+` for motions with no
  attached button (`qcb,f+2`).

## [0.1.0] — 2026-08-11

Initial release.

### Modes
- **Freeplay recognition** — moves performed on the controller appear in a
  fading ticker with name, Tekken notation, and labeled Xbox button icons;
  Wind God Fist inputs are graded ⚡ Electric or shown with the measured
  `df→2` gap in ms.
- **Combo trainer** — curated combos plus any move from the move browser as a
  drill; numbered input cards grade each press (good/early/late/wrong/missed)
  with frame deltas, a metronome plays the target rhythm, and a Tekken-style
  input history strip shows what was actually pressed.
- **Notation drill** — random commands shown as notation text only; input them
  on the pad. Misses reveal the answer as button icons next to what was
  pressed and repeat the prompt; tracks streak and accuracy. Three
  difficulties (1–3 inputs) with on-screen buttons.

### Engine
- XInput polling (koffi FFI) with d-pad + face buttons mapped to Tekken limbs;
  user-configurable binds and facing side (P1/P2).
- Input-sequence recognizer over Jin's full Tekken 8 command list
  (123/128 moves recognizable), sourced from the Wavu wiki, including
  just-frame (Electric) detection and stance-entry inference (ZEN).
- Synthetic-input engine tests: `npm run test-engine`.

### Overlay & windows
- Transparent, always-on-top, click-through overlay: draggable, resizable,
  lockable, with named appearance presets from fully solid to ghost, per-user
  zoom, and an optional only-over-the-game mode (foreground window title
  watch — still zero game interaction).
- Frameless dark-themed move browser (searchable command list with frame
  data) and settings window (overlay appearance, binds, hotkeys, drill
  difficulty) — settings apply instantly and persist.
- Global hotkeys (F1–F12, all rebindable) mirroring the clickable controls.

### Tooling
- `npm run dev` — hot reload for renderer changes.
- `npm run dist` / `npm run pack` — Windows installer / unpacked build via
  electron-builder; packaged installs keep config in `%APPDATA%`.

### Safety posture
- No memory reading, no injection, no hooks, no game-file modification —
  controller input via XInput and an OS-level overlay window only. Designed
  for offline practice.
