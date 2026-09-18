# CLAUDE.md — Longshot

A progressive web app that turns a video of someone scrolling a chat log or
console into one tall still image. Everything runs in the browser; there is no
server, no upload, and no build step.

## Machine constraints (inherited from the host)

- MacBook Air, Intel x86_64, macOS 15.7.9. **No Homebrew, no Node, no npm.**
- Do not introduce a build step, a bundler, or an npm dependency. The app is
  plain ES modules served as-is, which is *why* it can be developed here at all.
- Tools live in `$HOME/bin` and are not reliably on PATH — call them by full path.

## Running it

```sh
./serve.command
```

Serves the repo on <http://localhost:8765/> with the Python 3 that ships with
macOS. A plain `file://` open will not work: ES modules and service workers both
require an origin.

## Tests

```sh
./tests/run.sh
```

Headless tests of the registration math and of capture deletion, run under
JavaScriptCore (ships with macOS — no toolchain to install). The registration
tests cover shift recovery, rejection of false matches, a full scroll path with
pauses and reversals, drift behaviour, and relocalisation.
`tests/recording.test.mjs` asserts that deleting a capture really does revoke
every URL it issued and drop the video data.

```sh
./tests/run-browser.sh
```

The end-to-end test: drives the real pipeline over a synthetic scroll and
pixel-compares the reconstruction against the document it was generated from,
and checks ROI detection against a window with known chrome. It runs a
Chromium-family browser headless (Brave, Chrome, Chromium or Edge — set
`BROWSER` to override, `HEADLESS=0` to watch it). `tests/browser.html` is the
same test, openable by hand from the dev server for the visual diff.

## Deploying

```sh
./scripts/push.sh "Commit subject in imperative mood"
```

GitHub Pages serves `main` at the repo root, so a push *is* the deploy. There is
no CI step and nothing to build.

## Credentials

There is no credentials file, deliberately. `scripts/push.sh` asks the `gh` CLI
for a token at push time and passes it inline to that one `git push`. Nothing is
written to `.git/config` or to the working tree.

- Never print a token or write one into a tracked file.
- Never run `git remote set-url` with a token in it.
- If `gh auth token` fails, the fix is `gh auth login`, not a stored secret.

## Architecture, and what is load-bearing

The pipeline is five stages, each its own module:

| Module | Job |
|---|---|
| `js/capture.js` | File picker and single-window recording; owns the capture's lifetime and deletion; normalises to a seekable `<video>` |
| `js/roi.js` | Finds the scrolling viewport by temporal variance across sampled frames |
| `js/register.js` | 1-D row signatures, normalised cross-correlation, confidence, fusion |
| `js/docmap.js` | Signature of the reconstructed document in absolute coordinates |
| `js/stitch.js` | Tiled compositor, arbitrating overlaps by per-row sharpness |
| `js/export.js` | PNG export, slicing when the result exceeds the canvas ceiling |
| `js/pipeline.js` | The loop: predict, re-anchor, bisect, relocalise, composite |

Things that look like details but are not:

- **Registration is tracked in document coordinates, not frame to frame.** That
  is the whole reason scrolling back up works. `DocMap` is the memory.
- **`fusePosition` is a complementary filter, not a choice between estimates.**
  Dead reckoning is sub-pixel but accumulates; the map is absolute but quantised
  to whole rows. Letting the map overwrite the prediction measurably *degrades*
  clean recordings — there is a test for this. Deadband plus partial gain.
- **Drift is only correctable over ground already mapped**, and only back to the
  error that was current when that ground was first seen. There is no absolute
  reference. The tests assert shrinking error, not zero error.
- **The confidence ratio test matters more than the peak.** A console showing
  twenty identical log lines correlates beautifully at the wrong offset.
- **`repaint()` in the pipeline exists because bisection recurses.** The
  full-resolution scratch canvas can hold a different moment than the frame being
  composited. Removing it reintroduces a silent pixel-attribution bug.
- **A capture has exactly one owner.** `Recording` holds the Blob, every object
  URL issued for it and the `<video>` built from it, and `delete()` tears down
  all three. Handing the Blob around and revoking URLs ad hoc is how "the
  recording is deleted" quietly stops being true: an un-revoked object URL keeps
  the video alive. `js/main.js` routes *every* exit — the button, the end of a
  stitch, starting over, `pagehide` — through `deleteRecording()`.
- **`displaySurface: 'window'` is a preference, not a guarantee.** The browser
  may still hand back a monitor, so the surface is read back off the track and
  reported to the user. Telling them they shared one window when they shared the
  desktop is the bad failure here.
- **The ROI must exclude static chrome.** A fixed toolbar inside the crop gets
  stamped in at every scroll position.
