// Download speed from byte samples (Chrome reports no speed).
// Keeps a 5 s window per id and smooths readings, so the number settles
// instead of jumping. Used by the popup list, the progress window and the
// manager page.

const SAMPLE_WINDOW_MS = 5000;
const MIN_SAMPLE_SPAN_MS = 600;
const SMOOTHING = 0.4; // weight of the newest reading

export class SpeedTracker {
  constructor() {
    this.tracks = new Map(); // id -> { samples: [{t, bytes}], speed }
  }

  /** Record `bytes` received so far for `id`. Returns the smoothed speed (bytes/s) or null. */
  sample(id, bytes, now = performance.now()) {
    let track = this.tracks.get(id);
    if (!track) {
      track = { samples: [], speed: null };
      this.tracks.set(id, track);
    }
    const { samples } = track;
    const last = samples[samples.length - 1];
    if (!last || last.bytes !== bytes || now - last.t >= 400) samples.push({ t: now, bytes });
    while (samples.length > 2 && now - samples[0].t > SAMPLE_WINDOW_MS) samples.shift();
    const first = samples[0];
    const newest = samples[samples.length - 1];
    const span = newest.t - first.t;
    if (span >= MIN_SAMPLE_SPAN_MS) {
      const reading = Math.max(0, ((newest.bytes - first.bytes) * 1000) / span);
      track.speed = track.speed == null ? reading : track.speed * (1 - SMOOTHING) + reading * SMOOTHING;
    }
    return track.speed;
  }

  get(id) {
    return this.tracks.get(id)?.speed ?? null;
  }

  /** Forget every id not in `keep` (paused, finished or erased downloads start fresh). */
  retain(keep) {
    for (const id of this.tracks.keys()) if (!keep.has(id)) this.tracks.delete(id);
  }
}

/** Seconds left from speed, or from Chrome's estimatedEndTime as a fallback. NaN if unknown. */
export function secondsLeft(item, speed) {
  const total = item.totalBytes > 0 ? item.totalBytes : -1;
  if (speed > 0 && total > 0) return (total - item.bytesReceived) / speed;
  if (item.estimatedEndTime) return (Date.parse(item.estimatedEndTime) - Date.now()) / 1000;
  return NaN;
}
