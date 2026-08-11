# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
