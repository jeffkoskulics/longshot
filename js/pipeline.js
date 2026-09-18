import { rowSignature, colSignature, bestShift, matchDocument, fusePosition } from './register.js';
import { DocMap } from './docmap.js';
import { Stitcher } from './stitch.js';
import { seek } from './roi.js';

const SIG_W = 192;          // signatures are computed at this width, not full res
const MIN_OVERLAP_FRAC = 0.25;
const DOC_REFINE_RADIUS = 24;
const RELOCATE_RADIUS_FRAMES = 3;
const MAX_BISECT = 4;

const SCORE_OK = 0.55;
const MARGIN_OK = 0.06;
const RELOCATE_SCORE_OK = 0.60;

export const defaults = {
  sampleFps: 10,
  maxDxPerStep: 12,
};

// The real entry point: a video plus the crop rectangle to stitch.
export function stitchVideo(video, roi, opts = {}) {
  return stitchFrames({
    duration: video.duration,
    width: roi.w,
    height: roi.h,
    capture: async (t, ctx) => {
      await seek(video, t);
      ctx.drawImage(video, roi.x, roi.y, roi.w, roi.h, 0, 0, roi.w, roi.h);
    },
    ...opts,
  });
}

// The stitching loop, over any source that can paint frame `t` into a context.
// Keeping the source pluggable is what lets the browser self-test drive this
// exact code path with synthetic frames and a known ground truth.
export async function stitchFrames({
  duration, width: W, height: H, capture, ...opts
}) {
  const cfg = { ...defaults, ...opts };
  const { onProgress, onFrame, signal } = cfg;

  const minOverlap = Math.max(16, Math.round(H * MIN_OVERLAP_FRAC));
  const maxShift = Math.round(H * (1 - MIN_OVERLAP_FRAC));

  const full = document.createElement('canvas');
  full.width = W;
  full.height = H;
  const fullCtx = full.getContext('2d');

  const sigCanvas = document.createElement('canvas');
  sigCanvas.width = SIG_W;
  sigCanvas.height = H;
  const sigCtx = sigCanvas.getContext('2d', { willReadFrequently: true });

  const doc = new DocMap();
  const stitcher = new Stitcher(W, H);

  // Which moment the full-resolution scratch currently holds. Bisection can
  // capture further frames before an earlier one is composited, so the pixels in
  // `full` are not necessarily the ones about to be pasted - this tracks that,
  // and repaint() puts the right ones back when they disagree.
  let fullAtTime = null;

  async function grab(t) {
    await capture(t, fullCtx, W, H);
    fullAtTime = t;
    sigCtx.drawImage(full, 0, 0, SIG_W, H);
    const img = sigCtx.getImageData(0, 0, SIG_W, H);
    return { sig: rowSignature(img), cols: colSignature(img), t };
  }

  async function repaint(t) {
    if (fullAtTime === t) return;
    await capture(t, fullCtx, W, H);
    fullAtTime = t;
  }

  const stats = {
    frames: 0, placed: 0, bisections: 0, relocations: 0, lost: 0, corrected: 0,
    minY: 0, maxY: 0,
  };

  const step = 1 / cfg.sampleFps;
  const t0 = Math.min(0.02, duration / 100);

  let prev = await grab(t0);
  let y = 0;
  let xOffset = 0;
  doc.add(prev.sig, y);
  stitcher.place(full, y, prev.sig.grad, xOffset);
  stats.frames = 1;
  stats.placed = 1;

  let tPrev = t0;
  let lost = false;

  for (let t = t0 + step; t <= duration; t += step) {
    if (signal?.aborted) break;

    const res = await advance(t, tPrev, prev, y, 0);
    if (res) {
      y = res.y;
      xOffset = res.xOffset;
      prev = res.frame;
      tPrev = res.t;
      lost = false;
    } else {
      lost = true;
      stats.lost++;
    }

    stats.frames++;
    onProgress?.(Math.min(1, t / duration), { ...stats, height: stitcher.height, lost });
    // Yield so the page stays responsive and progress actually paints.
    if (stats.frames % 4 === 0) await raf();
  }

  stats.minY = stitcher.minY;
  stats.maxY = stitcher.maxY;
  return { stitcher, doc, stats };

  // Register the frame at `t` against the frame at `tPrevLocal`. When the match
  // is not trustworthy and there is time between the two samples to exploit,
  // bisect: a fast flick that moved more than a frame height leaves no overlap
  // to correlate on, and the fix is simply to look at an intermediate moment.
  async function advance(t, tPrevLocal, prevFrame, yPrev, depth) {
    const frame = await grab(t);

    const f2f = bestShift(prevFrame.sig, frame.sig, {
      min: -maxShift, max: maxShift, minOverlap,
    });
    const confident = f2f.ok && f2f.score >= SCORE_OK && f2f.margin >= MARGIN_OK;

    if (!confident) {
      if (depth < MAX_BISECT && t - tPrevLocal > 1 / 240) {
        stats.bisections++;
        const mid = (t + tPrevLocal) / 2;
        const first = await advance(mid, tPrevLocal, prevFrame, yPrev, depth + 1);
        if (first) {
          return (await advance(t, first.t, first.frame, first.y, depth + 1)) || first;
        }
      }
      // Out of subdivisions. Look for this frame anywhere near ground already
      // covered - after a fast flick the content may be somewhere the
      // neighbour search never reached.
      const wide = matchDocument(
        doc, frame.sig, yPrev, RELOCATE_RADIUS_FRAMES * H, minOverlap
      );
      if (wide.ok && wide.score >= RELOCATE_SCORE_OK && wide.margin >= MARGIN_OK) {
        stats.relocations++;
        return await commit(frame, wide.y, t, prevFrame);
      }
      return null;
    }

    // Dead reckoning gives the prediction; the map corrects its drift.
    const predicted = yPrev + f2f.shift;
    const refined = matchDocument(doc, frame.sig, predicted, DOC_REFINE_RADIUS, minOverlap);
    const fused = fusePosition(predicted, refined);
    if (fused.corrected) stats.corrected += Math.abs(fused.corrected);

    return await commit(frame, fused.y, t, prevFrame);
  }

  async function commit(frame, yNew, t, prevFrame) {
    const dx = estimateDx(prevFrame.cols, frame.cols, cfg.maxDxPerStep);
    const xNew = clamp(xOffset + dx, -24, 24);

    await repaint(t);
    doc.add(frame.sig, yNew);
    stitcher.place(full, yNew, frame.sig.grad, xNew);
    stats.placed++;
    onFrame?.({ t, y: yNew, x: xNew });
    return { y: yNew, xOffset: xNew, frame, t };
  }
}

// Small horizontal correction, for a source window that got nudged mid-record.
function estimateDx(a, b, maxDx) {
  let best = 0;
  let bestScore = -Infinity;
  const n = a.length;
  for (let s = -maxDx; s <= maxDx; s++) {
    const lo = Math.max(0, s);
    const hi = Math.min(n, n + s);
    if (hi - lo < n * 0.5) continue;
    let sa = 0, sb = 0, c = 0;
    for (let i = lo; i < hi; i++) { sa += a[i]; sb += b[i - s]; c++; }
    const ma = sa / c, mb = sb / c;
    let num = 0, d1 = 0, d2 = 0;
    for (let i = lo; i < hi; i++) {
      const u = a[i] - ma, v = b[i - s] - mb;
      num += u * v; d1 += u * u; d2 += v * v;
    }
    const den = Math.sqrt(d1 * d2);
    if (den < 1e-6) continue;
    const score = num / den;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  // Only act on a clear horizontal match; otherwise assume the window is still.
  return bestScore > 0.8 ? -best : 0;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const raf = () => new Promise((r) => requestAnimationFrame(r));
