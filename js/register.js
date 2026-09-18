// Frame-to-frame and frame-to-document registration.
//
// Everything here works on 1-D signatures rather than raw pixels. A chat log or
// console is a stack of text rows separated by blank gaps, so collapsing a frame
// to one value per row keeps almost all of the vertical information while making
// the search hundreds of times cheaper than 2-D correlation.

// Two signals per row, both cheap and complementary:
//   lum  - mean luminance. Strong for text-vs-gap structure.
//   grad - mean |dI/dx|. Strong for "is there text here at all", and it doubles
//          as the sharpness score the compositor uses to pick between frames.
export function rowSignature(imageData) {
  const { data, width, height } = imageData;
  const lum = new Float32Array(height);
  const grad = new Float32Array(height);

  for (let y = 0; y < height; y++) {
    let row = y * width * 4;
    let sum = 0;
    let gsum = 0;
    let prev = lumaAt(data, row);
    sum += prev;
    for (let x = 1; x < width; x++) {
      const v = lumaAt(data, row + x * 4);
      sum += v;
      gsum += Math.abs(v - prev);
      prev = v;
    }
    lum[y] = sum / width;
    grad[y] = gsum / (width - 1);
  }
  return { lum, grad, height };
}

// Column signature, used only for the small horizontal corrections that happen
// when the source window gets nudged mid-recording.
export function colSignature(imageData) {
  const { data, width, height } = imageData;
  const lum = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) sum += lumaAt(data, (y * width + x) * 4);
    lum[x] = sum / height;
  }
  return lum;
}

function lumaAt(data, i) {
  return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
}

// Normalized cross-correlation of `a` against `b` for one candidate shift.
//
// Convention: a point of the document visible at row y of the *previous* frame
// appears at row y - shift of the *current* frame. So positive shift means the
// document advanced downward (the user scrolled down).
//
// Zero-meaning happens inside the overlap only. That matters: a partial overlap
// normalized against whole-frame statistics scores systematically wrong, which
// is what makes naive correlators drift at the ends of a scroll.
function nccAt(a, b, shift, minOverlap) {
  const n = a.length;
  const lo = Math.max(0, shift);
  const hi = Math.min(n, n + shift);
  const count = hi - lo;
  if (count < minOverlap) return null;

  let sa = 0, sb = 0;
  for (let y = lo; y < hi; y++) {
    sa += a[y];
    sb += b[y - shift];
  }
  const ma = sa / count;
  const mb = sb / count;

  let num = 0, da = 0, db = 0;
  for (let y = lo; y < hi; y++) {
    const va = a[y] - ma;
    const vb = b[y - shift] - mb;
    num += va * vb;
    da += va * va;
    db += vb * vb;
  }
  const den = Math.sqrt(da * db);
  if (den < 1e-6) return null;
  return num / den;
}

// Search a shift range and return the best match with a confidence measure.
//
// Confidence is deliberately two-part. A high peak alone is not enough: a
// console showing twenty identical log lines correlates beautifully at the wrong
// offset. The ratio test - how far the best peak stands above the best rival
// outside its own lobe - is what actually catches that case.
export function bestShift(prev, curr, { min, max, minOverlap, lumWeight = 0.6 }) {
  let bestScore = -Infinity;
  let bestShift = 0;
  const scores = new Map();

  for (let s = min; s <= max; s++) {
    const l = nccAt(prev.lum, curr.lum, s, minOverlap);
    if (l === null) continue;
    const g = nccAt(prev.grad, curr.grad, s, minOverlap);
    const score = g === null ? l : lumWeight * l + (1 - lumWeight) * g;
    scores.set(s, score);
    if (score > bestScore) {
      bestScore = score;
      bestShift = s;
    }
  }
  if (bestScore === -Infinity) return { shift: 0, score: 0, margin: 0, ok: false };

  // Best rival outside the peak's own lobe.
  let rival = -Infinity;
  for (const [s, v] of scores) {
    if (Math.abs(s - bestShift) <= 3) continue;
    if (v > rival) rival = v;
  }
  const margin = rival === -Infinity ? 1 : bestScore - rival;

  // Parabolic interpolation against the neighbours gives sub-pixel placement.
  // Rounding every frame to whole pixels is the other classic source of drift:
  // a systematic quarter-pixel bias over 600 frames is 150px of error.
  let refined = bestShift;
  const a = scores.get(bestShift - 1);
  const c = scores.get(bestShift + 1);
  if (a !== undefined && c !== undefined) {
    const denom = a - 2 * bestScore + c;
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (a - c)) / denom;
      if (Math.abs(delta) < 1) refined = bestShift + delta;
    }
  }

  return { shift: refined, score: bestScore, margin, ok: true };
}

// Match a frame against the accumulated document rather than against its
// neighbour. This is the loop closure: when the user scrolls back up over
// ground already covered, the frame is re-anchored to where that content
// actually lives, so accumulated frame-to-frame error is discarded instead of
// compounding. `predicted` seeds the search so the cost stays bounded.
export function matchDocument(doc, curr, predicted, radius, minOverlap) {
  const H = curr.height;
  let bestScore = -Infinity;
  let bestY = predicted;
  const scores = new Map();

  const start = Math.round(predicted - radius);
  const end = Math.round(predicted + radius);

  for (let y = start; y <= end; y++) {
    const s = doc.correlate(curr, y, minOverlap);
    if (s === null) continue;
    scores.set(y, s);
    if (s > bestScore) {
      bestScore = s;
      bestY = y;
    }
  }
  if (bestScore === -Infinity) return { y: predicted, score: 0, margin: 0, ok: false };

  let rival = -Infinity;
  for (const [y, v] of scores) {
    if (Math.abs(y - bestY) <= 3) continue;
    if (v > rival) rival = v;
  }

  let refined = bestY;
  const a = scores.get(bestY - 1);
  const c = scores.get(bestY + 1);
  if (a !== undefined && c !== undefined) {
    const denom = a - 2 * bestScore + c;
    if (Math.abs(denom) > 1e-9) {
      const delta = (0.5 * (a - c)) / denom;
      if (Math.abs(delta) < 1) refined = bestY + delta;
    }
  }

  return {
    y: refined,
    score: bestScore,
    margin: rival === -Infinity ? 1 : bestScore - rival,
    ok: true,
    _H: H,
  };
}

// Fuse the neighbour-based prediction with the document re-anchor.
//
// These two estimates have opposite characters. Frame-to-frame is sub-pixel
// accurate but has no absolute reference, so its error is small per step and
// accumulates. The document match has an absolute reference but is quantised to
// whole document rows, so its error is bounded but noisy at the pixel level.
//
// Letting the document match simply overwrite the prediction therefore makes
// things *worse* on a clean recording: it trades a fraction of a pixel of drift
// for a pixel of quantisation noise on every single frame. So treat it as a slow
// correction rather than a position - a deadband ignores disagreement small
// enough to be quantisation, and only partial gain is applied above it, so drift
// is pulled out over several frames without the noise coming in.
//
// A large disagreement is different in kind: that is not noise, it is the frame
// genuinely not being where dead reckoning thought. Those are taken in full.
export const FUSE = {
  deadband: 1.5,
  gain: 0.35,
  trustFully: 8,
  scoreOk: 0.55,
  marginOk: 0.06,
};

export function fusePosition(predicted, refined, cfg = FUSE) {
  if (!refined.ok || refined.score < cfg.scoreOk || refined.margin < cfg.marginOk) {
    return { y: predicted, corrected: 0 };
  }
  const err = refined.y - predicted;
  if (Math.abs(err) <= cfg.deadband) return { y: predicted, corrected: 0 };
  if (Math.abs(err) >= cfg.trustFully) return { y: refined.y, corrected: err };
  return { y: predicted + err * cfg.gain, corrected: err * cfg.gain };
}
