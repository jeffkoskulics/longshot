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

// How far a candidate may sit from the motion prediction before it is fully
// discounted, and by how much. The penalty is deliberately small: on a document
// with any variety at all the raw correlation difference between the true peak
// and its rivals is an order of magnitude larger, so the prior cannot overrule
// real evidence. Its whole job is to break ties that carry no evidence either
// way.
const PRIOR_WEIGHT = 0.25;
const LOBE = 3;

// How far apart two peaks must be to count as different explanations rather
// than two samples of the same one.
const PEAK_SEPARATION = 4;

// Search a shift range and return the best match, a confidence measure, and the
// rival explanations.
//
// Confidence is deliberately two-part. A high peak alone is not enough: a
// console showing twenty identical log lines correlates beautifully at the wrong
// offset. The ratio test - how far the best peak stands above the best rival
// outside its own lobe - is what actually catches that case.
//
// But catching it is not the same as handling it. A Teams or Slack log is very
// nearly periodic: uniform row pitch, a fixed avatar column, similar line
// lengths. Several shifts then correlate at *exactly* 1.0, the margin is 0, and
// a pure ratio test rejects every frame of a perfectly trackable scroll. So two
// things are added here.
//
// `predict` supplies what the shift is expected to be, from the velocity the
// scroll already had. Scrolling is continuous; a frame that could equally be
// +18 or +414 px is +18 if the last five frames were +18. The prediction enters
// as a small penalty on distance rather than as a hard window, so a genuine
// change in speed still wins on evidence.
//
// `candidates` hands the caller the well-separated peaks it did not pick, so an
// ambiguity the prior cannot settle can be put to an independent witness - the
// document map - instead of being thrown away.
export function bestShift(prev, curr, {
  min, max, minOverlap, lumWeight = 0.6, predict = null, sigma = 0,
}) {
  const scores = new Map();

  for (let s = min; s <= max; s++) {
    const l = nccAt(prev.lum, curr.lum, s, minOverlap);
    if (l === null) continue;
    const g = nccAt(prev.grad, curr.grad, s, minOverlap);
    const score = g === null ? l : lumWeight * l + (1 - lumWeight) * g;
    scores.set(s, score);
  }
  if (!scores.size) {
    return { shift: 0, score: 0, margin: 0, ok: false, ambiguous: false, candidates: [] };
  }

  // Distance from the prediction, in score units. Used *only* to order
  // candidates the correlation cannot separate - never to compute confidence.
  //
  // Letting the prior into the margin was tempting and wrong: penalising the
  // rivals of a prediction makes a wrong prediction look certain, which is
  // precisely the wrong behaviour at the one moment it matters - a fast flick,
  // where the true shift is nowhere near what the scroll was doing a moment ago.
  // So the confidence test below sees raw correlation and nothing else, exactly
  // as it did before, and the prior only gets a vote when that test is a tie.
  const spread = sigma > 0 ? sigma : 1;
  const penalty = (s) => {
    if (predict === null) return Math.abs(s) * 1e-9;
    const d = (s - predict) / spread;
    return PRIOR_WEIGHT * Math.min(1, d * d);
  };

  const TIE = 1e-4;
  let bestShift = 0;
  let bestScore = -Infinity;
  for (const [s, v] of scores) {
    if (v > bestScore + TIE) {
      bestScore = v; bestShift = s;
    } else if (v > bestScore - TIE && penalty(s) < penalty(bestShift)) {
      // Indistinguishable on evidence: take the one the scroll was heading for.
      bestScore = Math.max(bestScore, v); bestShift = s;
    }
  }

  // Best rival outside the peak's own lobe, on raw scores.
  let rival = -Infinity;
  for (const [s, v] of scores) {
    if (Math.abs(s - bestShift) <= LOBE) continue;
    if (v > rival) rival = v;
  }
  const margin = rival === -Infinity ? 1 : bestScore - rival;

  // The peaks that remain plausible, best first, for a caller that wants to ask
  // a second witness. Raw scores, so the caller is not re-reading our prior.
  const candidates = collectPeaks(scores, penalty, bestShift);

  return {
    shift: subpixel(scores, bestShift),
    score: bestScore,
    margin,
    ok: true,
    // True when the correlation surface genuinely does not distinguish the
    // options - the periodic-document case, as opposed to a plain bad match.
    ambiguous: bestScore >= 0.55 && margin < 0.06 && candidates.length > 1,
    candidates,
  };
}

// Local maxima, thinned so that two samples of one lobe do not both survive.
function collectPeaks(scores, penalty, bestShift, limit = 6) {
  const peaks = [];
  for (const [s, v] of scores) {
    const l = scores.get(s - 1);
    const r = scores.get(s + 1);
    if ((l !== undefined && l > v) || (r !== undefined && r > v)) continue;
    peaks.push({ shift: s, score: v, adj: v - penalty(s) });
  }
  // Best evidence first; the prior only orders peaks the evidence ties.
  peaks.sort((a, b) => (Math.abs(b.score - a.score) > 1e-4 ? b.score - a.score : a.adj > b.adj ? -1 : 1));

  const kept = [];
  for (const p of peaks) {
    if (kept.some((k) => Math.abs(k.shift - p.shift) < PEAK_SEPARATION)) continue;
    kept.push({ ...p, shift: subpixel(scores, p.shift) });
    if (kept.length >= limit) break;
  }
  // The chosen peak first, whatever the sort did with near-equal adjustments.
  kept.sort((a, b) => (Math.abs(a.shift - bestShift) < 1 ? -1 : 0) - (Math.abs(b.shift - bestShift) < 1 ? -1 : 0));
  return kept;
}

// Parabolic interpolation against the neighbours gives sub-pixel placement.
// Rounding every frame to whole pixels is the other classic source of drift: a
// systematic quarter-pixel bias over 600 frames is 150px of error.
function subpixel(scores, at) {
  const peak = scores.get(at);
  const a = scores.get(at - 1);
  const c = scores.get(at + 1);
  if (a === undefined || c === undefined) return at;
  const denom = a - 2 * peak + c;
  if (Math.abs(denom) < 1e-9) return at;
  const delta = (0.5 * (a - c)) / denom;
  return Math.abs(delta) < 1 ? at + delta : at;
}

// Match a frame against the accumulated document rather than against its
// neighbour. This is the loop closure: when the user scrolls back up over
// ground already covered, the frame is re-anchored to where that content
// actually lives, so accumulated frame-to-frame error is discarded instead of
// compounding. `predicted` seeds the search so the cost stays bounded.
export function matchDocument(doc, curr, predicted, radius, minOverlap) {
  const H = curr.height;
  const scores = new Map();

  const start = Math.round(predicted - radius);
  const end = Math.round(predicted + radius);

  for (let y = start; y <= end; y++) {
    const s = doc.correlate(curr, y, minOverlap);
    if (s === null) continue;
    scores.set(y, s);
  }
  if (!scores.size) return { y: predicted, score: 0, margin: 0, ok: false, ambiguous: false };

  // Same tie-break as bestShift, for the same reason: on a periodic log the map
  // correlates identically at several offsets, and resolving that by scan order
  // snapped the frame a row or two back on every single frame - which is exactly
  // how a scroll reconstructs shorter than it was, with messages duplicated.
  const spread = Math.max(1, radius / 2);
  const penalty = (y) => {
    const d = (y - predicted) / spread;
    return PRIOR_WEIGHT * Math.min(1, d * d);
  };

  let bestY = Math.round(predicted);
  let bestAdj = -Infinity;
  for (const [y, v] of scores) {
    const adj = v - penalty(y);
    if (adj > bestAdj) { bestAdj = adj; bestY = y; }
  }
  const bestScore = scores.get(bestY);

  let rival = -Infinity;
  for (const [y, v] of scores) {
    if (Math.abs(y - bestY) <= LOBE) continue;
    const adj = v - penalty(y);
    if (adj > rival) rival = adj;
  }
  const margin = rival === -Infinity ? 1 : bestAdj - rival;

  return {
    y: subpixel(scores, bestY),
    score: bestScore,
    margin,
    ok: true,
    ambiguous: bestScore >= 0.5 && margin < 0.06,
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
