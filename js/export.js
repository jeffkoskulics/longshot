// PNG export, with the browser's canvas ceiling accounted for.
//
// A long chat log easily reconstructs to 20,000+ pixels tall, which is past what
// some browsers will allocate or encode. Rather than silently handing back a
// blank or truncated image - the usual failure mode - probe the real limit and
// slice the output into as many overlapping panels as it takes.

const SLICE_OVERLAP = 48;

let cachedLimit = null;

export function maxCanvasHeight(width) {
  if (cachedLimit) return cachedLimit;
  // Binary search for the tallest canvas that actually retains a drawn pixel.
  let lo = 1024;
  let hi = 65536;
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2);
    if (canAllocate(width, mid)) lo = mid;
    else hi = mid - 1;
  }
  cachedLimit = lo;
  return lo;
}

function canAllocate(w, h) {
  try {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, h - 1, 1, 1);
    const d = ctx.getImageData(0, h - 1, 1, 1).data;
    return d[0] === 255;
  } catch {
    return false;
  }
}

export function planSlices(stitcher) {
  const top = stitcher.minY;
  const bottom = stitcher.maxY;
  const total = bottom - top;
  const limit = maxCanvasHeight(stitcher.frameW);

  if (total <= limit) return [{ from: top, to: bottom }];

  const slices = [];
  let y = top;
  while (y < bottom) {
    const to = Math.min(bottom, y + limit);
    slices.push({ from: y, to });
    if (to >= bottom) break;
    y = to - SLICE_OVERLAP;
  }
  return slices;
}

export async function exportPNGs(stitcher, baseName = 'longshot') {
  const slices = planSlices(stitcher);
  const files = [];
  for (let i = 0; i < slices.length; i++) {
    const { from, to } = slices[i];
    const canvas = stitcher.render(from, to);
    const blob = await toBlob(canvas);
    const name =
      slices.length === 1 ? `${baseName}.png` : `${baseName}-${String(i + 1).padStart(2, '0')}.png`;
    files.push({ name, blob, width: canvas.width, height: canvas.height });
  }
  return files;
}

function toBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png');
  });
}

export function download(file) {
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
