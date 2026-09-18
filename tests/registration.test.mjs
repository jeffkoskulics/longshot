// Runs under JavaScriptCore (see tests/run.sh) or Node. No DOM: it exercises the
// registration math directly, by synthesising row signatures for a fake chat log
// and driving them through a scroll path that goes down, pauses, comes back up,
// and flicks fast.

import { bestShift, matchDocument, fusePosition } from '../js/register.js';
import { DocMap } from '../js/docmap.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { print(`  ok   ${name}`); }
  else { failures++; print(`  FAIL ${name} ${detail}`); }
}

// A deterministic PRNG so a failure is reproducible.
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

// Build a document: bands of "text" rows and blank gaps, like a chat log.
const DOC_H = 12000;
const docLum = new Float32Array(DOC_H);
const docGrad = new Float32Array(DOC_H);
for (let y = 0; y < DOC_H; ) {
  const isText = rnd() > 0.35;
  const len = 2 + Math.floor(rnd() * (isText ? 14 : 22));
  const base = isText ? 90 + rnd() * 70 : 235 + rnd() * 10;
  const g = isText ? 30 + rnd() * 50 : 1 + rnd() * 2;
  for (let k = 0; k < len && y < DOC_H; k++, y++) {
    docLum[y] = base + (rnd() - 0.5) * 6;
    docGrad[y] = g + (rnd() - 0.5) * 3;
  }
}

const FRAME_H = 700;

// A frame is a window onto the document plus sensor noise; when the scroll is
// fast the frame is also motion blurred, which is exactly the case the
// compositor is supposed to notice.
// `y` is deliberately fractional and sampled by interpolation: real scrolling
// does not land on whole pixels, and a registrator that quietly rounds every
// step is exactly the one that drifts over a long recording.
function frameAt(y, blur = 0, gain = 1, bias = 0) {
  const lum = new Float32Array(FRAME_H);
  const grad = new Float32Array(FRAME_H);
  const k = Math.max(0, Math.round(blur));
  const sample = (arr, pos) => {
    const p0 = Math.floor(pos);
    const f = pos - p0;
    const a = p0 >= 0 && p0 < DOC_H ? arr[p0] : arr === docLum ? 255 : 0;
    const b = p0 + 1 >= 0 && p0 + 1 < DOC_H ? arr[p0 + 1] : arr === docLum ? 255 : 0;
    return a * (1 - f) + b * f;
  };
  for (let i = 0; i < FRAME_H; i++) {
    let sl = 0, sg = 0, n = 0;
    for (let b = -k; b <= k; b++) {
      sl += sample(docLum, y + i + b);
      sg += sample(docGrad, y + i + b);
      n++;
    }
    lum[i] = (sl / n) * gain + bias + (rnd() - 0.5) * 2.5;
    grad[i] = (sg / n) * gain + (rnd() - 0.5) * 1.5;
  }
  return { lum, grad, height: FRAME_H };
}

const minOverlap = Math.round(FRAME_H * 0.25);
const maxShift = Math.round(FRAME_H * 0.75);

print('frame-to-frame shift recovery');
for (const truth of [0, 3, 37, 180, 420, -37, -180, -420, 12.5, -63.25]) {
  const a = frameAt(2000);
  const b = frameAt(2000 + truth);
  const r = bestShift(a, b, { min: -maxShift, max: maxShift, minOverlap });
  check(`dy = ${truth}`, r.ok && Math.abs(r.shift - truth) < 1.0,
    `got ${r.ok ? r.shift.toFixed(2) : 'no match'} score=${r.score.toFixed(3)}`);
}

print('');
print('rejects a shift with no real overlap');
{
  const a = frameAt(1000);
  const b = frameAt(4800);
  const r = bestShift(a, b, { min: -maxShift, max: maxShift, minOverlap });
  const confident = r.ok && r.score >= 0.55 && r.margin >= 0.06;
  check('unrelated frames are not confidently matched', !confident,
    `score=${r.score.toFixed(3)} margin=${r.margin.toFixed(3)}`);
}

print('');
print('full scroll path, tracked in document coordinates');
{
  // Down, pause, back up over old ground, then down again past the far point.
  const path = [];
  let y = 0;
  for (let i = 0; i < 60; i++) { y += 55.37; path.push(y); }    // scroll down
  for (let i = 0; i < 12; i++) { path.push(y); }                // pause
  for (let i = 0; i < 30; i++) { y -= 70.19; path.push(y); }    // back up
  for (let i = 0; i < 10; i++) { path.push(y); }                // pause again
  for (let i = 0; i < 80; i++) { y += 60.63; path.push(y); }    // down past before

  const doc = new DocMap();
  let est = 0;
  let prev = frameAt(path[0]);
  doc.add(prev, est);

  let worst = 0;
  let naive = 0;          // frame-to-frame only, for comparison
  let worstNaive = 0;

  for (let i = 1; i < path.length; i++) {
    const blur = Math.min(4, Math.abs(path[i] - path[i - 1]) / 25);
    // Slow exposure drift, as a real recording of a screen has.
    const gain = 1 + 0.04 * Math.sin(i / 23);
    const bias = 3 * Math.sin(i / 17);
    const f = frameAt(path[i], blur, gain, bias);

    const f2f = bestShift(prev, f, { min: -maxShift, max: maxShift, minOverlap });
    naive += f2f.shift;
    worstNaive = Math.max(worstNaive, Math.abs(naive - (path[i] - path[0])));

    const predicted = est + f2f.shift;
    const refined = matchDocument(doc, f, predicted, 24, minOverlap);
    est = fusePosition(predicted, refined).y;

    doc.add(f, est);
    prev = f;
    worst = Math.max(worst, Math.abs(est - (path[i] - path[0])));
  }

  check('tracks the whole path within 3px', worst < 3.0, `worst error ${worst.toFixed(2)}px`);
  // On a clean recording dead reckoning is already sub-pixel, so the only thing
  // to prove here is that re-anchoring does not inject noise of its own.
  check('re-anchoring does not degrade a clean run', worst <= worstNaive + 0.25,
    `doc ${worst.toFixed(2)}px vs naive ${worstNaive.toFixed(2)}px`);
  check('map covers the full scrolled extent',
    doc.covered >= (Math.max(...path) - Math.min(...path)) + FRAME_H - 4,
    `covered ${doc.covered}`);
  print(`       (frame-to-frame alone drifted ${worstNaive.toFixed(2)}px)`);
}

print('');
print('drift correction when re-crossing mapped ground');
{
  // Give the frame-to-frame estimator a small systematic bias, which is what
  // dropped frames and one-sided motion blur amount to in practice.
  //
  // Going down, the error must accumulate: there is no absolute reference, and
  // the map is being written at the drifted positions, so it agrees with the
  // drift. Coming back up, each region pulls the estimate toward the drift that
  // was current when that region was *first* mapped - which is smaller the older
  // the ground. So the correct expectation is not zero error, it is error that
  // shrinks back toward the early, more accurate part of the map while dead
  // reckoning keeps diverging.
  const BIAS = 0.3;
  const doc = new DocMap();
  let est = 0, naive = 0;
  let prev = frameAt(0);
  doc.add(prev, est);

  const path = [];
  let y = 0;
  for (let i = 0; i < 80; i++) { y += 48.5; path.push(y); }
  for (let i = 0; i < 60; i++) { y -= 51.25; path.push(y); }

  let errAtTurn = 0, errAtEnd = 0, naiveAtEnd = 0;
  for (let i = 0; i < path.length; i++) {
    const f = frameAt(path[i]);
    const f2f = bestShift(prev, f, { min: -maxShift, max: maxShift, minOverlap });
    const biased = f2f.shift + BIAS;
    naive += biased;
    const pred = est + biased;
    est = fusePosition(pred, matchDocument(doc, f, pred, 24, minOverlap)).y;
    doc.add(f, est);
    prev = f;
    if (i === 79) errAtTurn = Math.abs(est - path[i]);
    if (i === path.length - 1) {
      errAtEnd = Math.abs(est - path[i]);
      naiveAtEnd = Math.abs(naive - path[i]);
    }
  }

  check('error shrinks when re-crossing older ground', errAtEnd < errAtTurn * 0.5,
    `turnaround ${errAtTurn.toFixed(2)}px -> end ${errAtEnd.toFixed(2)}px`);
  check('dead reckoning alone keeps diverging', errAtEnd < naiveAtEnd * 0.3,
    `fused ${errAtEnd.toFixed(2)}px vs naive ${naiveAtEnd.toFixed(2)}px`);
}

print('');
print('relocalisation after a jump the neighbour search cannot see');
{
  const doc = new DocMap();
  for (let y = 0; y <= 2400; y += 60) doc.add(frameAt(y), y);
  const jumped = frameAt(1730.4, 1, 1.03, -2);
  const r = matchDocument(doc, jumped, 400, 3 * FRAME_H, minOverlap);
  check('finds the frame 1330px from the prediction',
    r.ok && Math.abs(r.y - 1730.4) < 2.0,
    `got ${r.y.toFixed(2)} score=${r.score.toFixed(3)}`);
}

print('');
print(failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`);
if (failures) throw new Error('tests failed');
