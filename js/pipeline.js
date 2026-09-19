import { rowSignature, colSignature, bestShift, matchDocument, fusePosition } from './register.js';
import { DocMap } from './docmap.js';
import { Stitcher } from './stitch.js';
import { seek } from './roi.js';

const SIG_W = 192;          // signatures are computed at this width, not full res
const MIN_OVERLAP_FRAC = 0.25;
const DOC_REFINE_RADIUS = 24;
const RELOCATE_RADIUS_FRAMES = 3;
const MAX_BISECT = 4;

// Bisection exists to find an intermediate moment when a flick left no overlap.
// Below the source video's own frame interval there is no intermediate moment to
// find - seeking half a frame back returns the same picture - but the source
// rate is not known here, and capping this at a guessed rate costs real
// subdivisions on exactly the frames that need them most. MAX_BISECT already
// bounds the work; this only stops the recursion running away on a degenerate
// interval.
const MIN_BISECT_GAP = 1 / 240;

// How much the scroll speed is allowed to change between samples before the
// motion prior stops vouching for a candidate. Generous: this only has to be
// tight enough to separate one row pitch from another.
const VELOCITY_SPREAD = (v) => Math.max(12, Math.abs(v) * 0.6 + 12);

// A candidate the correlation surface cannot distinguish is accepted on the
// motion model alone only if it sits this close to where the scroll was going.
const COAST_TOLERANCE = (v) => Math.max(10, Math.abs(v) * 0.5 + 10);

// How close in raw correlation two peaks must be to count as aliases of one
// another - the same content matching at a different multiple of the row pitch -
// rather than as a good answer and a bad one.
const ALIAS_TOLERANCE = 0.02;

// The largest change in scroll speed, in pixels per sample, that is taken at
// face value.
//
// This is the guard on the failure that does the most visible damage. A flick
// faster than maxShift moves the content further than the correlator is able to
// look, so the true peak is not in the search range at all - and a correlation
// surface asked a question it cannot answer still returns its best row, often
// with a healthy score and margin, frequently pointing the wrong way. Accepting
// one of those pins the rest of the recording at the wrong offset: the error
// never recovers, because every later frame is measured against it.
//
// A scroll cannot reverse from +47 to -395 px between two samples. When the
// match says it did, the honest reading is not "the user did something strange"
// but "this pair is unmatchable" - so bisect, and look at a moment in between.
// The bound is deliberately loose: it has to pass a genuine hard reversal, and
// only needs to catch matches that are physically impossible.
const ACCEL_LIMIT = (predict, H) =>
  Math.max(0.25 * H, Math.abs(predict) * 1.5 + 0.25 * H);

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
    stats.frames++;
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
    ambiguous: 0, resolvedByMap: 0, coasted: 0, implausible: 0,
    minY: 0, maxY: 0,
  };

  // The scroll's speed in document pixels per sample, smoothed. This is the
  // only thing that can separate "+18" from "+414" on a log whose rows all look
  // alike, so it is kept across frames and fed back into the search as a prior.
  let velocity = null;
  const learnVelocity = (shift) => {
    velocity = velocity === null ? shift : velocity * 0.5 + shift * 0.5;
  };

  const step = 1 / cfg.sampleFps;
  const t0 = Math.min(0.02, duration / 100);

  let prev = await grab(t0);
  let y = 0;
  let xOffset = 0;
  doc.add(prev.sig, y);
  stitcher.place(full, y, prev.sig.grad, xOffset);
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

    // Scale the prediction to the actual gap between these two samples, which
    // halves on every level of bisection.
    const span = tPrevLocal === null ? 1 : (t - tPrevLocal) * cfg.sampleFps;
    const predict = velocity === null ? null : velocity * span;

    const f2f = bestShift(prevFrame.sig, frame.sig, {
      min: -maxShift, max: maxShift, minOverlap,
      predict,
      sigma: predict === null ? 0 : VELOCITY_SPREAD(velocity) * Math.max(1, span),
    });
    let confident = f2f.ok && f2f.score >= SCORE_OK && f2f.margin >= MARGIN_OK;
    let shift = f2f.shift;
    let by = 'track';

    // A confident match that the scroll could not physically have made is the
    // correlator answering a question that was out of its range. Send it to
    // bisection rather than believing it.
    if (confident && predict !== null &&
        Math.abs(f2f.shift - predict) > ACCEL_LIMIT(predict, H)) {
      stats.implausible++;
      confident = false;
    }

    // The correlation surface says several shifts fit equally well. That is the
    // periodic-log case, and it is not a failure - it is a question. Put it to
    // the document map, which knows about everything seen so far rather than
    // just the previous frame, and then to the motion model.
    if (!confident && f2f.ambiguous) {
      stats.ambiguous++;
      const picked = resolve(f2f.candidates, frame, yPrev, predict);
      if (picked) {
        shift = picked.shift;
        confident = true;
        by = picked.by;
        if (picked.by === 'map') stats.resolvedByMap++;
        else stats.coasted++;
      }
    }

    if (!confident) {
      if (depth < MAX_BISECT && t - tPrevLocal > MIN_BISECT_GAP) {
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
        return await commit(frame, wide.y, t, prevFrame, 'relocate');
      }
      return null;
    }

    // Dead reckoning gives the prediction; the map corrects its drift.
    const predicted = yPrev + shift;
    const refined = matchDocument(doc, frame.sig, predicted, DOC_REFINE_RADIUS, minOverlap);
    const fused = fusePosition(predicted, refined);
    if (fused.corrected) stats.corrected += Math.abs(fused.corrected);

    learnVelocity((fused.y - yPrev) / Math.max(1e-6, span));
    return await commit(frame, fused.y, t, prevFrame, by);
  }

  // Decide between shifts the frame-to-frame correlation rates equally.
  //
  // Two independent witnesses, in order of how much they actually know. The map
  // has seen the whole document, so where it can tell the candidates apart it
  // decides. Where it cannot - an exactly periodic log, where the map is as
  // repetitive as the frame - continuity of the scroll is the only information
  // left, and it is real information: a scroll that has been moving 18px a frame
  // is not suddenly moving -414.
  function resolve(candidates, frame, yPrev, predict) {
    if (!candidates || candidates.length < 2) return null;

    // Only peaks the evidence genuinely cannot separate are in play. A weaker
    // peak that merely happens to sit near the prediction is not an alias of the
    // right answer, it is the wrong answer, and coasting onto it is how a scroll
    // that paused gets credited with movement it never made.
    const top = Math.max(...candidates.map((c) => c.score));
    const alias = candidates.filter((c) => top - c.score <= ALIAS_TOLERANCE);
    if (alias.length < 2) return null;

    const scored = alias.map((c) => ({
      shift: c.shift,
      map: doc.correlate(frame.sig, yPrev + c.shift, minOverlap),
    })).filter((c) => c.map !== null);

    if (scored.length) {
      scored.sort((a, b) => b.map - a.map);
      const top = scored[0];
      const next = scored[1];
      if (top.map >= SCORE_OK && (!next || top.map - next.map >= MARGIN_OK)) {
        return { shift: top.shift, by: 'map' };
      }
    }

    if (predict === null) return null;
    const tol = COAST_TOLERANCE(velocity);
    const near = alias
      .filter((c) => Math.abs(c.shift - predict) <= tol)
      .sort((a, b) => Math.abs(a.shift - predict) - Math.abs(b.shift - predict));
    return near.length ? { shift: near[0].shift, by: 'motion' } : null;
  }

  async function commit(frame, yNew, t, prevFrame, by = 'track') {
    const dx = estimateDx(prevFrame.cols, frame.cols, cfg.maxDxPerStep);
    const xNew = clamp(xOffset + dx, -24, 24);

    await repaint(t);
    doc.add(frame.sig, yNew);
    stitcher.place(full, yNew, frame.sig.grad, xNew);
    stats.placed++;
    onFrame?.({ t, y: yNew, x: xNew, by });
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
