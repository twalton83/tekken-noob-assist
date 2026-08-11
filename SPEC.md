# Tekken Trainer — v1 Spec

An on-screen training overlay for Tekken 8 (PC/Steam) that reads Xbox controller
input, recognizes Jin's moves, and coaches combo timing.

## Safety posture (non-negotiable)
- **Never** reads game memory, injects code, hooks the game process, or modifies
  game files. Input comes exclusively from the controller via standard gamepad
  APIs (XInput); output is a transparent OS-level window drawn over the game —
  the same category as OBS/Discord overlays.
- **Offline/practice use only.** The app is not intended to run during online
  matches. Consequence: the app knows what was *pressed*, never what the game
  did with it (no hit-confirm detection).

## Decisions from interview (2026-08-11)
| Topic | Decision |
|---|---|
| Platform | PC (Steam), Windows 10 |
| Game | Tekken 8 |
| Character (v1) | Jin, **full moveset** recognized |
| Controller | Xbox controller, **d-pad** for directions |
| Display mode | Borderless windowed (required for overlay) |
| Notation | Tekken numpad notation with Xbox button icons underneath (both) |
| Timing reference | Derived from published frame data @60fps (windows tuned by hand) |
| Training feedback | Post-attempt summary (per-input early/late in frames/ms) + metronome/rhythm guide that plays the combo's correct cadence |
| Overlay position | Draggable with position lock; default bottom center |
| App control in-game | Global keyboard hotkeys (e.g. F1–F4: mode switch, next/prev combo, retry) |
| Stack | Electron + TypeScript |

## Two modes
1. **Freeplay recognition** — as you play (practice mode), detected moves appear
   as an unobtrusive ticker: move name + notation + button icons. Peripheral-
   vision friendly; no interaction needed.
2. **Combo trainer** — pick a combo via hotkeys; the overlay shows the input
   strip, the metronome plays the target rhythm, and after each attempt a
   summary shows which inputs were early/late and by how much.

## Core technical pieces
- **Input capture**: XInput polling at high frequency (target 1000Hz poll,
  timestamped) in the Electron main process or a small native helper; d-pad +
  face buttons + triggers/bumpers mapped to Tekken's 1/2/3/4 scheme
  (user-configurable binds, since Tekken allows rebinding).
- **Move recognition**: input-sequence matcher over a database of Jin's full
  Tekken 8 command list (notation → tokenized input sequence + timing
  constraints). Handles held directions (f vs F), neutral (N) requirements
  (EWGF just-frame), and multi-hit strings.
- **Move database**: sourced from community frame data (e.g. Wavu wiki),
  stored as JSON; encode incrementally — starter ~15 moves first, then fill to
  full list.
- **Overlay window**: transparent, always-on-top, click-through Electron
  BrowserWindow; draggable when unlocked.
- **Timing engine**: per-combo timing windows derived from frame data
  (startup + cancel windows, 1 frame = 16.67ms); grades each input transition.

## Open items (deferred, not blockers)
- Exact hotkey map.
- Audio design for the metronome (tick sounds, per-input pitch?).
- Whether stick input should also be read as fallback (v1: d-pad only).
- Verification pass on frame-data-derived windows (tune against real play).
