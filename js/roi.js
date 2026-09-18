// Automatic detection of the scrolling viewport.
//
// A recording of a chat window contains a lot that must NOT be stitched: the
// title bar, tab strip, the message composer pinned to the bottom, the desktop
// behind the window. Those regions are static; the scroll viewport is not. So
// sample frames across the whole clip, measure how much each pixel changes over
// time, and keep the largest rectangle that is actually moving.
//
// Getting this wrong is not a cosmetic problem - a fixed toolbar included in the
// crop gets pasted at every scroll position and smears the output.

const SAMPLES = 14;
const WORK_W = 320;

export function detectROI(video, opts = {}) {
  return detectROIFromSource({
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
    draw: async (t, ctx, w, h) => {
      await seek(video, t);
      ctx.drawImage(video, 0, 0, w, h);
    },
  }, opts);
}

// Detection over any source that can paint whole frames, so it can be exercised
// against a synthetic window with known chrome as well as against real video.
export async function detectROIFromSource(source, { onProgress } = {}) {
  const { duration, width: srcW, height: srcH, draw } = source;
  if (!isFinite(duration) || duration <= 0) return null;

  const scale = WORK_W / srcW;
  const w = WORK_W;
  const h = Math.max(1, Math.round(srcH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const frames = [];
  for (let i = 0; i < SAMPLES; i++) {
    // Avoid the very first and last instants; players often hand back a blank
    // or duplicated frame at the exact boundaries.
    const t = duration * (0.02 + 0.96 * (i / (SAMPLES - 1)));
    await draw(t, ctx, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const gray = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) {
      const k = p * 4;
      gray[p] = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2];
    }
    frames.push(gray);
    onProgress?.((i + 1) / SAMPLES);
  }

  // Per-pixel temporal standard deviation.
  const n = frames.length;
  const varmap = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    let sum = 0;
    for (let f = 0; f < n; f++) sum += frames[f][p];
    const mean = sum / n;
    let acc = 0;
    for (let f = 0; f < n; f++) {
      const dv = frames[f][p] - mean;
      acc += dv * dv;
    }
    varmap[p] = Math.sqrt(acc / n);
  }

  const rowScore = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) s += varmap[y * w + x];
    rowScore[y] = s / w;
  }
  const colScore = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = 0; y < h; y++) s += varmap[y * w + x];
    colScore[x] = s / h;
  }

  const rows = longestActiveRun(rowScore);
  const cols = longestActiveRun(colScore);
  if (!rows || !cols) return null;

  // Back to source-video pixels, inset by a pixel to avoid antialiased edges.
  const inv = 1 / scale;
  const rect = {
    x: Math.round(cols.start * inv) + 1,
    y: Math.round(rows.start * inv) + 1,
    w: Math.round((cols.end - cols.start) * inv) - 2,
    h: Math.round((rows.end - rows.start) * inv) - 2,
  };
  if (rect.w < 32 || rect.h < 32) return null;
  return rect;
}

// Threshold at a fraction of the peak, then take the longest contiguous run,
// tolerating short quiet stretches (a run of blank lines between messages is
// genuinely static even though it is inside the viewport).
function longestActiveRun(score, fracOfPeak = 0.18, bridge = 6) {
  let peak = 0;
  for (const v of score) if (v > peak) peak = v;
  if (peak < 0.5) return null;
  const thresh = peak * fracOfPeak;

  const active = Array.from(score, (v) => v >= thresh);
  for (let i = 0; i < active.length; i++) {
    if (active[i]) continue;
    let j = i;
    while (j < active.length && !active[j]) j++;
    if (j - i <= bridge && i > 0 && j < active.length) {
      for (let k = i; k < j; k++) active[k] = true;
    }
    i = j;
  }

  let best = null, start = -1;
  for (let i = 0; i <= active.length; i++) {
    if (i < active.length && active[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      if (!best || i - start > best.end - best.start) best = { start, end: i };
      start = -1;
    }
  }
  return best;
}

export function seek(video, t) {
  return new Promise((resolve) => {
    const done = () => {
      video.removeEventListener('seeked', done);
      resolve();
    };
    video.addEventListener('seeked', done);
    video.currentTime = Math.min(t, Math.max(0, video.duration - 1e-3));
  });
}
