// The compositor. Holds the reconstructed document as a column of fixed-height
// tiles in absolute coordinates, so it can be written to at any position, in any
// order, growing upward as readily as downward.
//
// The interesting decision here is what to do where frames overlap - which is
// most of the image, and all of it if the user scrolled back and forth. Simply
// letting the last frame win produces visibly soft text, because the frames
// captured mid-scroll are motion blurred. Instead each document row remembers
// how sharp the frame that wrote it was, and a new frame only takes the row if
// it is sharper. The output ends up assembled from whichever pass over each
// region happened to be the slowest.

const TILE_H = 512;
const X_PAD = 32; // slack for horizontal window drift

export class Stitcher {
  constructor(width, height) {
    this.frameW = width;
    this.frameH = height;
    this.tileW = width + X_PAD * 2;
    this.tiles = new Map();
    this.quality = new GrowableF32();
    this.minY = Infinity;
    this.maxY = -Infinity;
  }

  _tile(idx) {
    let t = this.tiles.get(idx);
    if (!t) {
      const canvas = document.createElement('canvas');
      canvas.width = this.tileW;
      canvas.height = TILE_H;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      t = { canvas, ctx };
      this.tiles.set(idx, t);
    }
    return t;
  }

  // `source` is a canvas holding just the ROI of one frame at full resolution.
  // `top` is the document row that source row 0 maps to. `rowQuality` is the
  // per-row sharpness score, and `xOffset` the horizontal correction.
  place(source, top, rowQuality, xOffset = 0) {
    const H = this.frameH;
    const yTop = Math.round(top);
    const dx = Math.max(-X_PAD, Math.min(X_PAD, Math.round(xOffset)));

    // Find contiguous runs of rows this frame wins, so we can blit a span at a
    // time instead of issuing a draw call per row.
    let runStart = -1;
    for (let i = 0; i <= H; i++) {
      const docY = yTop + i;
      const wins =
        i < H && rowQuality[i] > this.quality.get(docY) * 1.02;
      if (wins) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        this._blit(source, runStart, i - runStart, yTop + runStart, dx);
        for (let k = runStart; k < i; k++) {
          this.quality.set(yTop + k, rowQuality[k]);
        }
        runStart = -1;
      }
    }

    if (yTop < this.minY) this.minY = yTop;
    if (yTop + H > this.maxY) this.maxY = yTop + H;
  }

  _blit(source, srcY, len, docY, dx) {
    let remaining = len;
    let sy = srcY;
    let dy = docY;
    while (remaining > 0) {
      const idx = Math.floor(dy / TILE_H);
      const local = dy - idx * TILE_H;
      const take = Math.min(remaining, TILE_H - local);
      const { ctx } = this._tile(idx);
      ctx.drawImage(
        source,
        0, sy, this.frameW, take,
        X_PAD + dx, local, this.frameW, take
      );
      remaining -= take;
      sy += take;
      dy += take;
    }
  }

  get height() {
    return this.maxY > this.minY ? this.maxY - this.minY : 0;
  }

  // Render the covered extent into one canvas. Callers must respect the
  // browser's maximum canvas dimension; see export.js, which slices instead.
  render(fromY = this.minY, toY = this.maxY) {
    const h = Math.max(1, toY - fromY);
    const out = document.createElement('canvas');
    out.width = this.frameW;
    out.height = h;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, h);

    const first = Math.floor(fromY / TILE_H);
    const last = Math.floor((toY - 1) / TILE_H);
    for (let idx = first; idx <= last; idx++) {
      const t = this.tiles.get(idx);
      if (!t) continue;
      const tileTop = idx * TILE_H;
      const sy = Math.max(0, fromY - tileTop);
      const ey = Math.min(TILE_H, toY - tileTop);
      if (ey <= sy) continue;
      ctx.drawImage(
        t.canvas,
        X_PAD, sy, this.frameW, ey - sy,
        0, tileTop + sy - fromY, this.frameW, ey - sy
      );
    }
    return out;
  }
}

// A Float32Array addressable by any integer, including negatives.
class GrowableF32 {
  constructor() {
    this.origin = 0;
    this.buf = new Float32Array(4096);
  }
  get(i) {
    const k = i - this.origin;
    return k >= 0 && k < this.buf.length ? this.buf[k] : 0;
  }
  set(i, v) {
    let k = i - this.origin;
    if (k < 0 || k >= this.buf.length) {
      const padBefore = k < 0 ? Math.max(4096, -k + 4096) : 0;
      const size = padBefore + Math.max(this.buf.length, k + 4096);
      const next = new Float32Array(size);
      next.set(this.buf, padBefore);
      this.buf = next;
      this.origin -= padBefore;
      k = i - this.origin;
    }
    this.buf[k] = v;
  }
}
