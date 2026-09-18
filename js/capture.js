// Getting a video in: either pick a file, or record the screen here.
//
// Screen recording is only offered when getDisplayMedia is actually usable -
// it is absent on iOS Safari, where the system screen recorder plus the file
// picker is the working path.

export const canRecordScreen = () =>
  !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia && window.MediaRecorder);

export async function recordScreen({ onStart, onStop } = {}) {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: { ideal: 30 }, cursor: 'never' },
    audio: false,
  });

  const mime = pickMime();
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);

  const finished = new Promise((resolve) => {
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'video/webm' });
      onStop?.();
      resolve(blob);
    };
  });

  // If the user ends the share from the browser's own bar, stop cleanly.
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (recorder.state !== 'inactive') recorder.stop();
  });

  recorder.start(250);
  onStart?.();
  return { stop: () => recorder.state !== 'inactive' && recorder.stop(), finished };
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

// Load a Blob or File into a <video> and wait until it can actually be seeked.
export function loadVideo(source) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.src = URL.createObjectURL(source);

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
