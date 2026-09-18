# Longshot

Record yourself scrolling through a chat log or a console window. Get one tall
still image back.

**[Open the app →](https://jeffkoskulics.github.io/longshot/)**

Everything happens on your device. The video is never uploaded anywhere — there
is no server to upload it to.

## Why a video

Screenshot-stitching tools generally ask you to take a series of careful,
non-overlapping screenshots. That is tedious and easy to get wrong. Scrolling
while recording is something you can do without thinking about it, and a video
carries far more redundancy than a handful of stills: every row of the document
is seen in a dozen frames, so the app can pick the sharpest look at each one.

The cost is that the app has to work out *where* every frame sits, which is the
interesting part.

## How it works

1. **Find the scrolling area.** Sample frames across the clip and measure how
   much each pixel changes over time. Title bars, tab strips and the message
   composer are static; the viewport is not. The largest moving rectangle is the
   crop — adjustable by hand, because getting this wrong stamps a fixed toolbar
   into the output at every scroll position.

2. **Reduce each frame to a 1-D signature.** A chat log is a stack of text rows
   separated by gaps, so collapsing a frame to two numbers per row — mean
   luminance and mean horizontal gradient — keeps nearly all the vertical
   information at a fraction of the cost of 2-D matching.

3. **Register each frame.** Normalised cross-correlation against the previous
   frame gives a sub-pixel vertical shift, accepted only if the correlation peak
   both clears a threshold *and* stands clear of its best rival. That second test
   is what stops twenty identical log lines from matching confidently at the
   wrong offset.

4. **Re-anchor against everything seen so far.** Positions accumulate into a
   document-coordinate map that spans everywhere you have scrolled. Each frame is
   matched back against it, so scrolling up over old ground lands on the rows it
   actually belongs to instead of compounding error. Fast flicks that leave no
   overlap are handled by bisecting the time interval; if that fails, the frame
   is searched for across a wide span of the map.

5. **Composite by sharpness.** Frames captured mid-scroll are motion blurred. Each
   document row remembers how sharp the frame that wrote it was, and a later frame
   only takes the row if it is sharper. The output ends up assembled from
   whichever pass over each region happened to be the slowest.

6. **Export.** A long log easily reconstructs past what a browser will encode in
   one image, so the result is sliced into overlapping panels when it has to be.

## Recording a good source

- Scroll steadily rather than flicking. Pausing is fine, and so is going back.
- Keep the window still. Small drift is corrected; moving the window a long way
  mid-recording is not.
- Avoid overlapping the window with anything that moves on its own.
- A higher frame rate helps more than a higher resolution.

## What it does not do

- **Horizontal scrolling.** Vertical only.
- **Content that changes while you record.** A log still being written to will
  reconstruct as whatever was on screen when each region was passed.
- **Unbounded drift correction.** Error is pulled back only over ground already
  mapped, and only to the accuracy that ground was first mapped with. There is no
  absolute reference; a long one-way scroll has nothing to correct against.

## Development

No build step, no dependencies, no Node. Plain ES modules.

```sh
./serve.command
```

Then <http://localhost:8765/>. Tests:

```sh
./tests/run.sh
```

Those run under JavaScriptCore, which ships with macOS. The end-to-end test
drives the real pipeline over a synthetic scroll and pixel-compares the result
against the document it was generated from:

```sh
./tests/run-browser.sh
```

Open `tests/browser.html` from the dev server to watch it and see the diff.

## Licence

MIT
