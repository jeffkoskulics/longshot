// Deleting a capture, tested without a browser.
//
// The claim the UI makes is specific: when a capture ends, the recording is
// released - the Blob is dropped and every object URL handed out for it is
// revoked. That is checkable with stubs, so it is checked here rather than by
// eye in a screen-share.

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) { print(`  ok   ${name}`); }
  else { failures++; print(`  FAIL ${name} ${detail}`); }
}

// Minimal stand-ins for the three browser objects capture.js touches. Installed
// before the module is imported, hence the dynamic import below.
const live = new Set();
let issued = 0;

if (typeof globalThis.Blob === 'undefined') {
  globalThis.Blob = class Blob {
    constructor(parts = []) {
      this.size = parts.reduce((n, p) => n + (p?.size ?? p?.length ?? 0), 0);
    }
  };
}
globalThis.URL = {
  createObjectURL() { const u = `blob:stub/${++issued}`; live.add(u); return u; },
  revokeObjectURL(u) { live.delete(u); },
};

const { Recording } = await import('../js/capture.js');

const rec = new Recording(new Blob(['x'.repeat(2048)]), { surface: 'window', label: 'Terminal' });

check('reports the surface it captured', rec.surface === 'window');
check('reports the window title', rec.label === 'Terminal');
check('starts undeleted with a size', !rec.deleted && rec.size === 2048);

const a = rec.url();
const b = rec.url();
check('hands out object URLs', live.size === 2 && a !== b);

// A <video> stand-in, adopted the way loadVideo adopts the real one.
let loaded = 0;
const video = {
  dataset: { objectUrl: a },
  pause() {},
  load() { loaded++; },
  removeAttribute(k) { this.removed = k; },
};
rec.adopt(video);

rec.delete();

check('marks itself deleted', rec.deleted === true);
check('revokes every URL it issued', live.size === 0, `${live.size} left`);
check('detaches the adopted video', video.removed === 'src' && loaded === 1);
check('drops the video data', rec.size === 0);

let threw = false;
try { rec.url(); } catch { threw = true; }
check('refuses to hand out a URL afterwards', threw);

rec.delete();
check('deleting twice is harmless', rec.deleted === true && live.size === 0);

print(failures ? `\n${failures} failure(s)` : '\nall recording tests passed');
if (failures && typeof process !== 'undefined') process.exitCode = 1;
