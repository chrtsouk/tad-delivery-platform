/**
 * Generated alert sounds (WebAudio, no audio files).
 * Browsers keep audio locked until the user has interacted with the page, so we expose `useAudioLocked()`:
 * the Board shows an "Enable sound" button while it is true. The first click/tap/key anywhere also unlocks it silently.
 */
import { useSyncExternalStore } from 'react';

let ctx = null;
let gestureSeen = false;
const subs = new Set();
const emit = () => subs.forEach((f) => f());

const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
export const audioSupported = Boolean(AC);

function getCtx() {
  if (ctx || !AC) return ctx;
  ctx = new AC();
  ctx.onstatechange = emit;
  return ctx;
}

/** True while the browser would refuse to play a sound. */
export function isLocked() {
  if (!AC) return true;
  if (ctx) return ctx.state !== 'running';
  const active = typeof navigator !== 'undefined' && navigator.userActivation ? navigator.userActivation.hasBeenActive : gestureSeen;
  return !active;
}

/** Call from a click/tap/key handler. Resolves to true when sound can now play. */
export async function unlockAudio() {
  const c = getCtx();
  if (!c) return false;
  try { if (c.state !== 'running') await c.resume(); } catch { /* still locked */ }
  if (c.state === 'running') tone(c, 440, c.currentTime, 0.001, 'sine', 0.0001); // silent blip finishes the unlock on Safari
  emit();
  return c.state === 'running';
}

if (typeof window !== 'undefined' && AC) {
  const onGesture = () => {
    gestureSeen = true;
    unlockAudio();
    ['pointerdown', 'keydown', 'touchend'].forEach((ev) => window.removeEventListener(ev, onGesture, true));
  };
  ['pointerdown', 'keydown', 'touchend'].forEach((ev) => window.addEventListener(ev, onGesture, true));
}

const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
export const useAudioLocked = () => useSyncExternalStore(subscribe, isLocked, () => true);

function tone(c, freq, start, dur, type = 'sine', vol = 0.28) {
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g);
  g.connect(c.destination);
  o.start(start);
  o.stop(start + dur + 0.03);
}

function play(notes) {
  if (isLocked()) return false;
  const c = getCtx();
  if (!c || c.state !== 'running') return false;
  const t0 = c.currentTime + 0.02;
  notes.forEach(([f, at, dur, type, vol]) => tone(c, f, t0 + at, dur, type, vol));
  return true;
}

/** Friendly two-note chime: a new order has arrived. */
export const playNewOrder = () => play([[880, 0, 0.18], [1318, 0.18, 0.3], [880, 0.5, 0.18], [1318, 0.68, 0.3]]);
/** Harsher triple beep: an order has just become late. */
export const playLate = () => play([[520, 0, 0.16, 'square', 0.18], [520, 0.24, 0.16, 'square', 0.18], [520, 0.48, 0.3, 'square', 0.18]]);
