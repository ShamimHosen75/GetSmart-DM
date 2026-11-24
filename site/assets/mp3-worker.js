// Turns decoded sound (Float32 samples, one array per channel) into MP3 frames.
// Runs off the page's main thread so the page stays responsive.
// Encoder: lamejs (LGPL-3.0, a JavaScript port of LAME, https://lame.sourceforge.io/),
// unchanged in vendor/lame.min.js.
/* global lamejs */
importScripts('vendor/lame.min.js');

const BLOCK = 1152 * 20;

function toInt16(samples, start, end) {
  const out = new Int16Array(end - start);
  for (let i = start; i < end; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out[i - start] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

self.onmessage = (e) => {
  const { sampleRate, kbps, channels } = e.data;
  try {
    const encoder = new lamejs.Mp3Encoder(channels.length, sampleRate, kbps);
    const length = channels[0].length;
    const chunks = [];
    let lastReport = 0;
    for (let start = 0; start < length; start += BLOCK) {
      const end = Math.min(length, start + BLOCK);
      const left = toInt16(channels[0], start, end);
      const right = channels.length > 1 ? toInt16(channels[1], start, end) : undefined;
      const frame = right ? encoder.encodeBuffer(left, right) : encoder.encodeBuffer(left);
      if (frame.length) chunks.push(new Uint8Array(frame));
      if (end - lastReport > sampleRate * 5 || end === length) {
        lastReport = end;
        self.postMessage({ type: 'progress', value: end / length });
      }
    }
    const tail = encoder.flush();
    if (tail.length) chunks.push(new Uint8Array(tail));
    self.postMessage({ type: 'done', chunks }, chunks.map((c) => c.buffer));
  } catch (err) {
    self.postMessage({ type: 'error', message: `The MP3 could not be made: ${err.message || err}` });
  }
};
