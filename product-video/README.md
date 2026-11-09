# Still — Kinetic Product Film

A 30-second, 1920×1080, **60fps** product film built around **recorded interactions with Still's actual React app**. The film opens with large kinetic type, alternates dark UI close-ups with light and coral editorial cuts, and includes an original 120-BPM score and picture-synchronized sound design.

This replaces the earlier tilted-screenshot slideshow. No product UI is redrawn in Remotion.

## Preview and render

From this directory:

```sh
npm run studio
npm run render
npm run render:no-music
```

The rendered H.264 MP4 is written to `out/still-product-film.mp4`. The no-music version retains the sound effects. `StillFilm`, `StillFilmNoMusic`, and the seven-second `OpeningCut` render at 60fps. `StillFilm30fps` is a 30fps compatibility composition (`npm run render:30fps`). The previously approved render is retained in `out/still-product-film-approved-30fps.mp4`.

On this host, Studio is available at `http://100.86.95.34:3000/StillFilm`. A copy of the last checked render is currently available at `http://100.86.95.34:3000/static-f36ff6698feb/still-product-film.mp4`; replace `public/still-product-film.mp4` with the new render after subsequent edits if using that direct preview URL. Remotion's static-prefix hash may change when Studio is restarted, so the composition URL is the stable entry point.

## Actual app footage

`scripts/capture-native.mjs` samples the actual app at port 1420 **once for every 1/60-second of the take**, using Playwright's controlled clock and explicit sampling of the browser's CSS/Web Animations. Screenshots use the real 1440×810 viewport at 1.5 device scale, producing 2160×1170 footage after cropping the 30px test banner. Screenshot/encoding speed does not determine playback timing. There is no screencast frame dropping, 30fps up-conversion or sped-up UI playback.

The old `scripts/capture.mjs` remains as a legacy recorder only. Its low-cadence screencast and baked-in, camera-scaled pointer were the source of the laggy-looking interactions; increasing the final composition FPS did not repair those source frames.

Synthetic demo accounts and example history are isolated in fresh browser contexts: no actual server, account, or personal conversation is recorded. Production app code is not modified by the recorder.

The original blue test navigation banner is cropped out of the footage; **“Actual Still UI · demo data”** remains visible on the video’s product shots. The footage is genuine UI, but the agent events are simulated examples, not proof of a real agent execution or completed checks.

Recorded interactions:

- Opening the actual model selector, choosing a model, and typing a prompt.
- Searching saved conversations and opening the matching thread.
- Expanding the native Todo panel and applying a synthetic progress event through the existing test bridge.
- Reading the actual approval dialog and pressing **Allow once**.
- Opening **Changes** and switching between two real diff-rendering views.

To recapture, first run the app, then from this directory:

```sh
npm run capture
npm run soundtrack
npm run qa
npm run typecheck
```

The recorder uses the parent application's existing Playwright installation, Python uses NumPy, and the local ffmpeg build needs `libopenh264` for capture encoding. Remotion supplies its own final H.264 encoder. `STILL_CAPTURE_URL` and `FFMPEG` can override capture defaults. One recording can be refreshed with `node scripts/capture-native.mjs approval`; comma-separated clip names are also supported.

`public/captures/v4/manifest.json` records capture dimensions, exact interaction/key timestamps, pointer trajectories, and a frame-by-frame Todo animation audit. New source clips live in `public/footage/v4/`. The original stills used in the laptop illustration remain in `public/captures/v3/`.

### Natural interactions

- The pointer is **not baked into the footage**. `CursorOverlay.tsx` renders a standard 24px screen-space pointer independently of the product camera, with the correct arrow/hand/text hotspot. No click rings, cursor pulses or elastic scaling are added. Zooming into the app no longer makes the pointer enormous.
- `cursor-motion.ts` shares the exact same short, lightly curved movement paths between capture and Remotion. The native browser pointer traverses each path at 60 samples per second, lands, pauses briefly, and actually clicks the real control. No four-step mouse jumps or wall-clock actionability delays remain.
- All five clips play at real time (`playbackRate=1`), with click/key sounds taken from their exact frame timestamps.
- The Todo's production width/grid transition rewrapped its text and jumped in height during expansion. A **capture-only** adapter lays out the actual expanded DOM at its final width, interpolates the real panel height and horizontal reveal from the collapsed pill, and fades in unchanged text without stretching it. Animating the actual layout height also makes the conversation's scroll adjustment gradual rather than instant. This is film choreography, not a production UI change. The audit checks stable text geometry, a monotonic panel expansion, and bounded per-frame conversation movement.
- Camera travel waits for the Todo expansion to settle, and the diff camera leaves the file list visible while the pointer selects the next file.

## Creative structure

### Motion polish

The approved story, visuals, app recordings, music and 30-second duration are preserved. The smoother revision adds:

- Native 60fps rendering for camera motion, typography, graphics, transitions, the pointer, and the newly sampled app footage. No optical-flow interpolation smears the UI text.
- Longer, zero-velocity/zero-acceleration camera starts and stops, with perceptually even zooming.
- Camera endpoints constrained before interpolation, removing the small hitch when a moving crop reaches the edge of the recording.
- A continuous push into the diff instead of the six-frame crash-zoom and recoil.
- Gentle overlapping wipes and narrow-feather reveals instead of abrupt cuts and fast opaque color curtains. Whole headlines never cross-dissolve over one another.
- Softer type entrances and spring settling, a smoother laptop hinge, and quieter transition sweeps timed to the reveals.

Shot timing remains authored in a 30fps reference timebase and is scaled at delivery. Each outgoing scene is extended only by its handoff duration; overlaps subtract that exact amount, so every incoming shot still starts on its original musical beat.

| Time | Shot |
| --- | --- |
| 0:00–0:02.5 | “Vibe code. Not babysit.” — large type and a coral cut |
| 0:02.5–0:07 | Choose a model and type a real prompt |
| 0:07–0:10.5 | A close-up of searching saved conversations |
| 0:10.5–0:14.5 | Expand the actual Todo panel; follow its progress |
| 0:14.5–0:16 | Coffee break — a small visual joke |
| 0:16–0:19.5 | Read an operation and grant one-time approval |
| 0:19.5–0:24 | Open Changes, push into the code, switch files |
| 0:24–0:27 | The actual workspace on a closing laptop illustration |
| 0:27–0:30 | Still’s shipped icon, serif wordmark and repository link |

All edits align to the original score's 120-BPM grid. All Remotion animation is frame-driven and deterministic. The stills used for the laptop and the recorded interactions come from the current source UI. Fonts and provider/Still marks are copied from the application's shipped local assets.

## Remotion packages

- `remotion` and `@remotion/cli` power the composition and Studio.
- `OffthreadVideo` provides frame-accurate app footage with trims expressed at the delivery frame rate.
- `@remotion/transitions` supplies the overlapping, named `TransitionSeries` shots and eased wipes. `src/transitions.tsx` provides the custom narrow-feather reveal that avoids full-frame text ghosting.

## Shotcraft references

The user-provided [video-shotcraft gallery](https://vincentwei1021.github.io/video-shotcraft/) informed the revised motion language. The Gallery index, recipe cards and exact demo implementations were read before adaptation:

- [type-and-filter](https://vincentwei1021.github.io/video-shotcraft/#type-and-filter): meaningful search → result → click causality; implemented with the real app rather than simulated filtering.
- [crash-zoom-punch](https://vincentwei1021.github.io/video-shotcraft/#crash-zoom-punch): informed the earlier emphasis shot. At the user's request, the polished cut replaces its quick impact/recoil with a slower continuous push while retaining the readable end framing.
- [title-demote-to-label](https://vincentwei1021.github.io/video-shotcraft/#title-demote-to-label) and shot-transition references were also inspected; neither source demo nor its fictional UI was copied into this film.

## Audio and verification

`scripts/soundtrack.py` synthesizes the entire score and all sound effects from fixed-seed signals. It generates `public/audio/still-groove.wav` and `public/audio/still-picture-sfx.wav`. No third-party songs, sound samples, credentials or paid services are used. Clicks and individual keystrokes are scheduled from the native-capture manifest.

`scripts/qa.mjs` bundles once and renders representative frames from every scene and handoff into `out/qa-smooth/<composition>/`. Arguments are still in 30fps reference units and are mapped to the selected composition's actual FPS. Use `QA_COMPOSITION=StillFilm30fps` to inspect the same moments at 30fps.

`npm run test:motion` checks easing continuity, identical real-time choreography at 30/60fps, constrained camera travel without overshoot, and preservation of all nine shot start times and the exact 30-second total. Final video inspection should also include the first/last frame, transition edges, full code lines, native UI interactions, audio peaks and output metadata.

`npm run test:interactions` checks the actual encoded source frame counts/dimensions/cadence, transition handles, stable Todo text layout and intermediate animation states, settled pointer locations at clicks, continuous pointer paths, and fixed cursor size.

`TodoInteraction` is a four-second, silent Studio composition for inspecting the click, panel expansion, pointer movement and task update without replaying the whole film. The native capture revision produces 1,410 source samples across the five clips. Its Todo expansion has 22 distinct reveal states, constant 22.09375px text-line height, and no instantaneous conversation scroll jump.

The checked native-interaction render is copied to `public/still-product-film.mp4`; `public/todo-interaction.mp4` contains the focused Todo preview. Both are available under Studio's current static prefix. All nine motion/interaction tests and TypeScript pass. The final export was fully decoded and verified as 1,800 frames, 1080p/60fps, 30 seconds of picture with 48kHz AAC; peak level is −3dBFS and there are no detected black gaps. Production app files are unchanged by this video revision.

Verified for the smoother revision: TypeScript and all four motion tests pass; handoff and content frames were inspected; three same-time 30/60fps checks produce identical still images; Studio reports 60fps / 30 seconds and no browser errors. The final picture decodes all **1,800 frames** at 1920×1080/60fps, with 48kHz stereo AAC, no clipping (−3.0dBFS peak), and no detected black gaps of 0.15 seconds or longer. The no-music export reuses that exact encoded picture with the effects-only track. AAC padding makes the MP4 container 30.016 seconds; picture duration remains exactly 30 seconds.
