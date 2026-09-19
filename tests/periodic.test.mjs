// Registration against a near-periodic document.
//
// A Teams or Slack log is not a random image: uniform row pitch, a fixed avatar
// column, similar line lengths. Several shifts then correlate almost equally
// well, and the ratio test that protects against matching twenty identical log
// lines at the wrong offset starts rejecting frames that are perfectly
// trackable. These tests pin the behaviour that makes such a log usable - and,
// just as importantly, pin the limits on how far the motion prior is allowed to
// go, because a prior that can manufacture confidence is worse than no prior.

import { bestShift } from '../js/register.js';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { print(`  ok   ${name}`); }
  else { failures++; print(`  FAIL ${name}${detail ? '  — ' + detail : ''}`); }
}

// A document whose rows repeat with a fixed pitch, as a chat log's do.
// `variety` adds per-block variation: 0 is exactly periodic (genuinely
// ambiguous), higher is more like a real log.
function buildSignal(height, pitch, variety, seed = 3) {
  let s = seed;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const lum = new Float32Array(height);
  const grad = new Float32Array(height);
  const blocks = Math.ceil(height / pitch) + 2;
  const amp = [];
  for (let i = 0; i < blocks; i++) amp.push(1 + variety * (rnd() - 0.5));
  for (let y = 0; y < height; y++) {
    const b = Math.floor(y / pitch);
    const phase = y % pitch;
    const isText = phase < pitch * 0.45;
    lum[y] = (isText ? 90 : 240) * amp[b];
    grad[y] = (isText ? 60 : 2) * amp[b];
  }
  return { lum, grad, height };
}

function window_(sig, offset, H) {
  const lum = new Float32Array(H);
  const grad = new Float32Array(H);
  for (let i = 0; i < H; i++) {
    lum[i] = sig.lum[offset + i];
    grad[i] = sig.grad[offset + i];
  }
  return { lum, grad, height: H };
}

const H = 600;
const PITCH = 18;
const doc = buildSignal(6000, PITCH, 0.35);
const strict = buildSignal(6000, PITCH, 0);
const opts = { min: -450, max: 450, minOverlap: 150 };

print('\nnear-periodic log: the prior breaks ties the correlation cannot');
{
  const a = window_(doc, 1000, H);
  const b = window_(doc, 1000 + 54, H);   // 54 = 3 row pitches: a perfect alias

  const blind = bestShift(a, b, opts);
  const guided = bestShift(a, b, { ...opts, predict: 54, sigma: 40 });

  check('a prediction recovers the true shift', Math.abs(guided.shift - 54) < 1.5,
        `got ${guided.shift.toFixed(1)}`);
  check('the tie-break does not need to invent evidence',
        Math.abs(guided.score - blind.score) < 0.02,
        `scores ${blind.score.toFixed(3)} vs ${guided.score.toFixed(3)}`);
  check('rival explanations are reported', blind.candidates.length > 1,
        `${blind.candidates.length} candidate(s)`);
}

print('\nan exactly periodic document is reported as ambiguous, not answered');
{
  const a = window_(strict, 1000, H);
  const b = window_(strict, 1000 + 36, H);
  const r = bestShift(a, b, opts);
  check('the surface is flagged ambiguous', r.ambiguous === true,
        `margin ${r.margin.toFixed(4)}`);
  check('the margin is honest about the tie', r.margin < 0.06,
        `margin ${r.margin.toFixed(4)}`);
}

print('\na wrong prediction cannot manufacture confidence');
{
  // This is the failure mode that makes a fast flick unrecoverable: the true
  // shift is outside the search range, and a prior that penalises rivals makes
  // whatever is left look certain. Confidence must come from raw correlation.
  const a = window_(doc, 1000, H);
  const b = window_(doc, 1000 + 54, H);

  const honest = bestShift(a, b, opts);
  const misled = bestShift(a, b, { ...opts, predict: -300, sigma: 40 });

  check('the margin is unchanged by the prediction',
        Math.abs(misled.margin - honest.margin) < 1e-6,
        `${honest.margin.toFixed(4)} vs ${misled.margin.toFixed(4)}`);
  check('a badly predicted frame does not read as confident',
        !(misled.score >= 0.55 && misled.margin >= 0.06 && Math.abs(misled.shift + 300) < 50),
        `shift ${misled.shift.toFixed(1)}, margin ${misled.margin.toFixed(4)}`);
}

print('\nvaried content still decides on evidence alone');
{
  // Where the correlation surface is decisive the prior must be inert, or a
  // clean recording gets dragged toward whatever the scroll was doing before.
  const varied = buildSignal(6000, PITCH, 1.6, 11);
  const a = window_(varied, 1200, H);
  const b = window_(varied, 1200 + 46, H);

  const plain = bestShift(a, b, opts);
  const pulled = bestShift(a, b, { ...opts, predict: 0, sigma: 30 });

  check('the true shift is found without help', Math.abs(plain.shift - 46) < 1.5,
        `got ${plain.shift.toFixed(1)}`);
  check('a contrary prediction does not move it', Math.abs(pulled.shift - 46) < 1.5,
        `got ${pulled.shift.toFixed(1)}`);
  check('and it reads as confident', plain.score >= 0.55 && plain.margin >= 0.06,
        `score ${plain.score.toFixed(3)}, margin ${plain.margin.toFixed(4)}`);
}

print(failures ? `\n${failures} failure(s)` : '\nall periodic-registration tests passed');
if (failures && typeof process !== 'undefined') process.exitCode = 1;
