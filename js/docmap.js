// The document signature map: one row-signature entry per row of the *document*
// being reconstructed, in absolute coordinates that survive scrolling in either
// direction.
//
// This is the memory that makes back-and-forth scrolling work. Frame-to-frame
// matching alone only knows about the last frame; this knows about everywhere
// the user has already been.

const GROW = 2048;

export class DocMap {
  constructor() {
    // `origin` is the document coordinate stored at index 0. It goes negative
    // as the user scrolls back above wherever they happened to start.
    this.origin = 0;
    this.lum = new Float32Array(GROW);
    this.grad = new Float32Array(GROW);
    this.weight = new Float32Array(GROW);
    this.minY = Infinity;
    this.maxY = -Infinity;
  }

  _index(y) {
    return Math.round(y) - this.origin;
  }

  // Grow (and if needed re-origin) so that [lo, hi) is addressable.
  _ensure(lo, hi) {
    let iLo = lo - this.origin;
    let iHi = hi - this.origin;
    if (iLo >= 0 && iHi <= this.lum.length) return;

    const padBefore = iLo < 0 ? Math.max(GROW, -iLo + GROW) : 0;
    const needed = padBefore + Math.max(this.lum.length, iHi + GROW);

    const lum = new Float32Array(needed);
    const grad = new Float32Array(needed);
    const weight = new Float32Array(needed);
    lum.set(this.lum, padBefore);
    grad.set(this.grad, padBefore);
    weight.set(this.weight, padBefore);

    this.lum = lum;
    this.grad = grad;
    this.weight = weight;
    this.origin -= padBefore;
  }

  // Correlate a frame signature placed at document row `y`. Only rows the map
  // has actually seen contribute, so a frame that is half over new territory
  // still matches on the half that overlaps.
  correlate(sig, y, minOverlap, lumWeight = 0.6) {
    const H = sig.height;
    const base = this._index(y);
    const lo = Math.max(0, -base);
    const hi = Math.min(H, this.lum.length - base);
    if (hi - lo < minOverlap) return null;

    let n = 0, sa = 0, sb = 0, sc = 0, sd = 0;
    for (let i = lo; i < hi; i++) {
      if (this.weight[base + i] <= 0) continue;
      sa += this.lum[base + i];
      sb += sig.lum[i];
      sc += this.grad[base + i];
      sd += sig.grad[i];
      n++;
    }
    if (n < minOverlap) return null;

    const ma = sa / n, mb = sb / n, mc = sc / n, md = sd / n;
    let nl = 0, dl1 = 0, dl2 = 0, ng = 0, dg1 = 0, dg2 = 0;
    for (let i = lo; i < hi; i++) {
      const j = base + i;
      if (this.weight[j] <= 0) continue;
      const a = this.lum[j] - ma, b = sig.lum[i] - mb;
      nl += a * b; dl1 += a * a; dl2 += b * b;
      const c = this.grad[j] - mc, d = sig.grad[i] - md;
      ng += c * d; dg1 += c * c; dg2 += d * d;
    }

    const denL = Math.sqrt(dl1 * dl2);
    const denG = Math.sqrt(dg1 * dg2);
    if (denL < 1e-6) return null;
    const l = nl / denL;
    const g = denG < 1e-6 ? l : ng / denG;
    return lumWeight * l + (1 - lumWeight) * g;
  }

  // Fold a frame's signature in at document row `y`, as a running average so a
  // row seen ten times converges rather than being whipped around by whichever
  // frame happened to land last.
  add(sig, y) {
    const H = sig.height;
    const yi = Math.round(y);
    this._ensure(yi, yi + H);
    const base = this._index(y);
    for (let i = 0; i < H; i++) {
      const j = base + i;
      const w = this.weight[j];
      this.lum[j] = (this.lum[j] * w + sig.lum[i]) / (w + 1);
      this.grad[j] = (this.grad[j] * w + sig.grad[i]) / (w + 1);
      this.weight[j] = w + 1;
    }
    if (yi < this.minY) this.minY = yi;
    if (yi + H > this.maxY) this.maxY = yi + H;
  }

  get covered() {
    return this.maxY > this.minY ? this.maxY - this.minY : 0;
  }
}
