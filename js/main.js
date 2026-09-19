import { canRecordScreen, canPickWindow, recordScreen, loadVideo, releaseVideo, Recording } from './capture.js';
import { detectROI, seek } from './roi.js';
import { stitchVideo } from './pipeline.js';
import { exportPNGs, download } from './export.js';

const $ = (id) => document.getElementById(id);
const steps = ['step-input', 'step-crop', 'step-run', 'step-done'];

let video = null;
let roi = null;
let controller = null;
let recorder = null;

// The capture currently held in memory, if the video came from the recorder
// rather than the file picker. Longshot never writes it anywhere, but holding a
// Blob is still holding the recording, so there is exactly one owner and every
// path out of the app goes through deleteRecording().
let recording = null;

function show(id) {
  steps.forEach((s) => $(s).classList.toggle('active', s === id));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function fail(message) {
  const el = $('err');
  el.textContent = message;
  el.hidden = false;
}
function clearError() { $('err').hidden = true; }

// ---------------------------------------------------------------- input step

$('file').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (file) await accept(file);
  e.target.value = '';
});

if (canRecordScreen()) {
  $('record').hidden = false;
  $('record-hint').hidden = false;
  $('autodelete-wrap').hidden = false;
  if (!canPickWindow()) {
    $('record-hint').textContent =
      'This browser will not let the page pre-select a window, so pick one from the ' +
      'picker’s window list yourself — sharing a whole screen records everything on it.';
  }
} else {
  $('record-note').hidden = false;
}

$('record').addEventListener('click', async () => {
  clearError();
  status('');
  try {
    recorder = await recordScreen({ windowOnly: true });
    $('record').hidden = true;
    $('stop-record').hidden = false;
    status(describeSurface(recorder.surface, recorder.label, true));
    const captured = await recorder.finished;
    $('record').hidden = false;
    $('stop-record').hidden = true;
    await accept(captured);
  } catch (err) {
    $('record').hidden = false;
    $('stop-record').hidden = true;
    if (err?.name !== 'NotAllowedError') fail(err.message || String(err));
  }
});

$('stop-record').addEventListener('click', () => recorder?.stop());

function status(text) {
  const el = $('record-status');
  el.textContent = text;
  el.hidden = !text;
}

// The displaySurface constraint is a preference, not a promise: a browser may
// still hand back a whole monitor. Say which it was rather than implying the
// crop box is the only thing standing between the user and their desktop.
function describeSurface(surface, label, live) {
  const named = label ? ` — “${label}”` : '';
  if (surface === 'window') return `Recording one window${named}.`;
  if (surface === 'monitor') {
    return live
      ? 'You shared a whole screen, not a single window. That works, but everything on that screen is in the recording.'
      : 'That recording covers a whole screen rather than one window.';
  }
  if (surface === 'browser') return `Recording one browser tab${named}.`;
  return live ? 'Recording…' : '';
}

async function accept(source) {
  clearError();
  deleteRecording({ quiet: true });
  if (video) { releaseVideo(video); video = null; }
  recording = source instanceof Recording ? source : null;

  try {
    video = await loadVideo(source);
  } catch (err) {
    fail(err.message || String(err));
    return;
  }
  if (!video.videoWidth) {
    fail('That file has no video track this browser can read.');
    return;
  }
  showRecordingControls();
  show('step-crop');
  await drawPoster(0.02);
  await autoDetect();
}

// ------------------------------------------------------- deleting the capture

// Everything that ends a capture's usefulness routes here: the explicit button,
// the end of a successful stitch when auto-delete is on, starting over, and
// closing the page. It is safe to call when there is nothing to delete.
function deleteRecording({ quiet = false } = {}) {
  if (!recording) return false;
  const bytes = recording.size;
  if (video) { releaseVideo(video); video = null; }
  recording.delete();
  recording = null;
  showRecordingControls();
  if (!quiet) {
    const note = `Recording deleted — ${formatSize(bytes)} released. It was never written to disk or uploaded.`;
    $('recstat').textContent = note;
    $('recstat').hidden = false;
    status(note);
  }
  return true;
}

function formatSize(bytes) {
  if (!bytes) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// The delete buttons only mean anything while a recording is held; a video that
// came from the file picker is the user's own file and is not ours to delete.
function showRecordingControls() {
  const held = !!recording;
  $('discard').hidden = !held;
  $('discard-done').hidden = !held;
  const where = $('croprec');
  if (held) {
    const what = describeSurface(recording.surface, recording.label, false);
    where.textContent =
      (what ? `${what} ` : '') +
      `${formatSize(recording.size)} is held in memory and nowhere else — ` +
      'delete it whenever you like, or let it go automatically when the image is made.';
    where.hidden = false;
  } else {
    where.hidden = true;
  }
}

$('discard').addEventListener('click', () => {
  if (deleteRecording()) show('step-input');
});
$('discard-done').addEventListener('click', () => deleteRecording());

// Closing the tab drops the blob anyway; revoking on the way out means the URL
// does not outlive it in a browser that keeps the document alive in bfcache.
window.addEventListener('pagehide', () => deleteRecording({ quiet: true }));

// ----------------------------------------------------------------- crop step

const poster = $('poster');
const pctx = poster.getContext('2d');

async function drawPoster(t) {
  const maxW = Math.min(820, window.innerWidth - 64);
  const scale = Math.min(1, maxW / video.videoWidth);
  poster.width = Math.round(video.videoWidth * scale);
  poster.height = Math.round(video.videoHeight * scale);
  await seek(video, t);
  pctx.drawImage(video, 0, 0, poster.width, poster.height);
  paintRect();
}

$('scrub').addEventListener('input', (e) => {
  if (!video) return;
  drawPoster((e.target.value / 1000) * video.duration);
});

$('redetect').addEventListener('click', autoDetect);
$('back-input').addEventListener('click', () => { deleteRecording({ quiet: true }); show('step-input'); });
$('again').addEventListener('click', () => { deleteRecording({ quiet: true }); show('step-input'); });

async function autoDetect() {
  $('redetect').disabled = true;
  $('redetect').textContent = 'Detecting…';
  try {
    const found = await detectROI(video);
    roi = found || {
      x: Math.round(video.videoWidth * 0.1),
      y: Math.round(video.videoHeight * 0.15),
      w: Math.round(video.videoWidth * 0.8),
      h: Math.round(video.videoHeight * 0.7),
    };
    if (!found) {
      fail('Could not find a moving region automatically — set the box by hand.');
    } else {
      clearError();
    }
  } finally {
    $('redetect').disabled = false;
    $('redetect').textContent = 'Re-detect';
    paintRect();
  }
}

// The crop box is stored in source-video pixels and only projected into display
// pixels for drawing, so changing the preview size never disturbs the geometry.
const rectEl = $('croprect');

function viewScale() {
  return poster.width / video.videoWidth;
}

function paintRect() {
  if (!roi || !video) return;
  const s = viewScale();
  rectEl.style.left = `${roi.x * s}px`;
  rectEl.style.top = `${roi.y * s}px`;
  rectEl.style.width = `${roi.w * s}px`;
  rectEl.style.height = `${roi.h * s}px`;
}

let drag = null;
rectEl.addEventListener('pointerdown', (e) => {
  const mode = e.target.classList.contains('h')
    ? [...e.target.classList].find((c) => 'nswe'.includes(c) && c.length === 1)
    : 'move';
  drag = { mode, x: e.clientX, y: e.clientY, start: { ...roi } };
  rectEl.setPointerCapture(e.pointerId);
  e.preventDefault();
});

rectEl.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const s = viewScale();
  const dx = (e.clientX - drag.x) / s;
  const dy = (e.clientY - drag.y) / s;
  const r = { ...drag.start };

  if (drag.mode === 'move') { r.x += dx; r.y += dy; }
  if (drag.mode === 'n') { r.y += dy; r.h -= dy; }
  if (drag.mode === 's') { r.h += dy; }
  if (drag.mode === 'w') { r.x += dx; r.w -= dx; }
  if (drag.mode === 'e') { r.w += dx; }

  r.w = Math.max(32, r.w);
  r.h = Math.max(32, r.h);
  r.x = Math.max(0, Math.min(video.videoWidth - r.w, r.x));
  r.y = Math.max(0, Math.min(video.videoHeight - r.h, r.y));

  roi = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
  paintRect();
});

const endDrag = () => { drag = null; };
rectEl.addEventListener('pointerup', endDrag);
rectEl.addEventListener('pointercancel', endDrag);

window.addEventListener('resize', () => { if (video) drawPoster(video.currentTime); });

// ------------------------------------------------------------------ run step

$('go').addEventListener('click', async () => {
  clearError();
  show('step-run');
  controller = new AbortController();
  $('barfill').style.width = '0%';

  const started = performance.now();
  try {
    const { stitcher, stats } = await stitchVideo(video, roi, {
      sampleFps: Number($('fps').value),
      signal: controller.signal,
      onProgress: (p, s) => {
        $('barfill').style.width = `${(p * 100).toFixed(1)}%`;
        $('runstat').textContent =
          `${s.placed} frames placed · ${Math.round(s.height)} px tall` +
          (s.relocations ? ` · ${s.relocations} re-anchored` : '') +
          (s.lost ? ' · searching…' : '');
      },
    });

    if (stitcher.height < 1) {
      fail('Nothing was reconstructed. Check that the crop box covers the scrolling area.');
      show('step-crop');
      return;
    }

    await finish(stitcher, stats, performance.now() - started);
  } catch (err) {
    fail(err.message || String(err));
    show('step-crop');
  }
});

$('cancel').addEventListener('click', () => controller?.abort());

// ----------------------------------------------------------------- done step

async function finish(stitcher, stats, elapsedMs) {
  const files = await exportPNGs(stitcher);
  const ratio = (stitcher.height / roi.h).toFixed(1);

  // When a lot of frames could only be placed by leaning on scroll continuity,
  // the source was too uniform for the pixels alone to say where each frame
  // belonged. The result may still be right, but the user is the only one who
  // can confirm that, so say so rather than presenting it as measured.
  const assumed = (stats.resolvedByMap || 0) + (stats.coasted || 0);
  const uniform = stats.placed > 0 && assumed > stats.placed * 0.1;

  $('donestat').textContent =
    `${stitcher.frameW} × ${Math.round(stitcher.height)} px — about ${ratio} screens of content, ` +
    `from ${stats.placed} placed frames in ${(elapsedMs / 1000).toFixed(1)}s.` +
    (stats.lost ? ` ${stats.lost} frames could not be matched and were skipped.` : '') +
    (uniform
      ? ' This source repeats closely from row to row, so some frames were placed ' +
        'by following the scroll rather than by matching pixels — check the result ' +
        'against the original.'
      : '');

  const box = $('downloads');
  box.innerHTML = '';
  files.forEach((f) => {
    const b = document.createElement('button');
    b.className = 'btn primary';
    b.textContent =
      files.length === 1 ? 'Download PNG' : `Download ${f.name} (${f.height}px)`;
    b.addEventListener('click', () => download(f));
    box.appendChild(b);
  });
  if (files.length > 1) {
    const note = document.createElement('p');
    note.className = 'hint';
    note.textContent =
      `The result is taller than this browser will encode in one image, so it is split into ${files.length} overlapping panels.`;
    box.appendChild(note);
  }

  const prev = $('preview');
  prev.innerHTML = '';
  const img = new Image();
  img.src = URL.createObjectURL(files[0].blob);
  prev.appendChild(img);

  // Capture is over: the image is made, so the video has done its job.
  $('recstat').hidden = true;
  if (recording && $('autodelete').checked) {
    deleteRecording();
  } else if (recording) {
    $('recstat').textContent =
      `The recording (${formatSize(recording.size)}) is still held in memory. ` +
      'It is deleted when you start another or close this page.';
    $('recstat').hidden = false;
    showRecordingControls();
  }

  show('step-done');
}

// ----------------------------------------------------------------------- pwa

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}
