// Getting a video in: either pick a file, or record here.
//
// Screen recording is only offered when getDisplayMedia is actually usable -
// it is absent on iOS Safari, where the system screen recorder plus the file
// picker is the working path.
//
// Two things beyond "start a MediaRecorder" live here:
//
// - *Window* capture. Longshot only ever wants one scrolling window, so the
//   picker is asked for a window surface and steered away from whole monitors
//   and from this tab. The browser has the final say - the constraint is a
//   preference, not a guarantee - so what the user actually shared is read back
//   off the track and reported, and the caller warns rather than pretends.
//
// - *Deleting* the recording. A capture only ever exists as a Blob and an
//   object URL; nothing is written to disk. But a Blob stays alive as long as
//   anything references it, and an un-revoked object URL is exactly such a
//   reference, so "the user is done with it" has to be said out loud. That is
//   what Recording.delete() is for, and it is the only way a capture is
//   released in this app.

export const canRecordScreen = () =>
  !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);

// Whether the browser lets us ask for a particular surface type at all. Where
// it does not, the picker still offers windows - the user just has to pick one.
export const canPickWindow = () =>
  canRecordScreen() &&
  typeof navigator.mediaDevices.getSupportedConstraints === 'function' &&
  !!navigator.mediaDevices.getSupportedConstraints().displaySurface;

// A recorded capture, and the only handle on it. `blob` is the video; `delete()`
// drops it. Everything downstream (the <video> element, its object URL) is
// registered here so one call tears down the lot.
export class Recording {
  constructor(blob, { surface = '', label = '' } = {}) {
    this.blob = blob;
    this.surface = surface;      // what the user actually shared: window|monitor|browser
    this.label = label;          // the window's title, where the browser exposes it
    this.deleted = false;
    this._urls = new Set();
    this._videos = new Set();
  }

  get size() { return this.deleted ? 0 : this.blob.size; }

  // Hand out an object URL that delete() knows how to revoke.
  url() {
    if (this.deleted) throw new Error('That recording has already been deleted.');
    const u = URL.createObjectURL(this.blob);
    this._urls.add(u);
    return u;
  }

  adopt(video) {
    this._videos.add(video);
    return video;
  }

  // Idempotent: called from the "delete now" button, from the end of a stitch,
  // and from pagehide, in whatever order those happen to land.
  delete() {
    if (this.deleted) return;
    this.deleted = true;
    this._videos.forEach(detachVideo);
    this._videos.clear();
    this._urls.forEach((u) => URL.revokeObjectURL(u));
    this._urls.clear();
    this.blob = new Blob([], { type: 'video/webm' });
  }
}

// Record one window. `windowOnly` asks the picker for a window surface and hides
// whole screens and other tabs; it is a hint, so the result is checked.
export async function recordScreen({ windowOnly = true, onStart, onStop } = {}) {
  const video = { frameRate: { ideal: 30 }, cursor: 'never' };
  if (windowOnly) video.displaySurface = 'window';

  const constraints = { video, audio: false };
  if (windowOnly) {
    // Chromium honours these; other engines ignore unknown keys.
    constraints.selfBrowserSurface = 'exclude';   // never offer Longshot's own tab
    constraints.monitorTypeSurfaces = 'exclude';  // never offer a whole monitor
    constraints.surfaceSwitching = 'exclude';     // one window for the whole clip
  }

  const stream = await navigator.mediaDevices.getDisplayMedia(constraints);
  const track = stream.getVideoTracks()[0];
  const settings = track.getSettings?.() || {};

  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const finished = new Promise((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      chunks.length = 0;
      onStop?.();
      resolve(new Recording(blob, {
        surface: settings.displaySurface || '',
        label: track.label || '',
      }));
    };
  });

  // If the user ends the share from the browser's own bar - or closes the window
  // being captured - stop cleanly rather than recording a dead track.
  track.addEventListener('ended', () => {
    if (recorder.state !== 'inactive') recorder.stop();
  });

  recorder.start(250);
  onStart?.();
  return {
    surface: settings.displaySurface || '',
    label: track.label || '',
    stop: () => recorder.state !== 'inactive' && recorder.stop(),
    finished,
  };
}

function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
    'video/mp4',
  ];
  return candidates.find((c) => MediaRecorder.isTypeSupported?.(c)) || '';
}

// Load a Recording, Blob or File into a <video> and wait until it can actually
// be seeked. A Recording keeps ownership of the URL and the element so that
// deleting it really does release the pixels.
export function loadVideo(source) {
  const recording = source instanceof Recording ? source : null;
  const blob = recording ? recording.blob : source;

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    const url = recording ? recording.url() : URL.createObjectURL(blob);
    video.dataset.objectUrl = url;
    video.src = url;
    recording?.adopt(video);

    const fail = () => reject(new Error('Could not decode that video file.'));
    video.addEventListener('error', fail);
    video.addEventListener('loadedmetadata', async () => {
      // A blob-backed MediaRecorder file often reports duration Infinity until
      // it has been forced to scan to the end.
      if (!isFinite(video.duration)) {
        await resolveDuration(video);
      }
      resolve(video);
    });
  });
}

// For videos that came from the file picker: we do not own the user's file, but
// the decoded copy and its URL are ours to drop.
export function releaseVideo(video) {
  if (video) detachVideo(video);
}

function detachVideo(video) {
  try { video.pause(); } catch {}
  const url = video.dataset?.objectUrl;
  video.removeAttribute('src');
  try { video.load(); } catch {}
  if (url) URL.revokeObjectURL(url);
  delete video.dataset?.objectUrl;
}

function resolveDuration(video) {
  return new Promise((resolve) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      video.currentTime = 0;
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = 1e101;
  });
}
