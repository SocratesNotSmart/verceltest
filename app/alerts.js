// Everything that fires at the driver: beeps, vibration, speech, wake lock.
// Audio is created lazily on the first user gesture so mobile browsers let it play.

import { t, getLang, VOICE_LOCALE } from './i18n.js';

let ctx = null;
let wakeLock = null;

export function unlockAudio() {
  if (ctx) {
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  ctx = new Ctor();
  // A silent blip; some browsers only consider the context "unlocked" after one.
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  gain.gain.value = 0.0001;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + 0.01);
  return ctx;
}

function tone(freq, start, duration, volume = 0.3) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  const at = ctx.currentTime + start;
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(at);
  osc.stop(at + duration + 0.05);
}

export function beep(kind) {
  if (!ctx) return;
  if (ctx.state === 'suspended') ctx.resume();
  if (kind === 'inside') {
    // Urgent: three rising blasts.
    tone(880, 0, 0.18, 0.4);
    tone(1046, 0.22, 0.18, 0.4);
    tone(1318, 0.44, 0.3, 0.45);
  } else if (kind === 'approaching') {
    tone(660, 0, 0.15, 0.28);
    tone(660, 0.25, 0.15, 0.28);
  } else {
    tone(520, 0, 0.12, 0.18);
  }
}

export function vibrate(kind) {
  if (!navigator.vibrate) return;
  if (kind === 'inside') navigator.vibrate([300, 120, 300, 120, 500]);
  else if (kind === 'approaching') navigator.vibrate([180, 120, 180]);
  else navigator.vibrate(80);
}

let lastSpoken = 0;
export function speak(kind) {
  if (!window.speechSynthesis) return;
  const now = Date.now();
  if (now - lastSpoken < 8000) return; // don't stack utterances
  lastSpoken = now;
  const text = kind === 'inside' ? t('voiceInside') : t('voiceApproaching');
  const utter = new SpeechSynthesisUtterance(text);
  const locale = VOICE_LOCALE[getLang()] || 'en-GB';
  utter.lang = locale;
  const voices = window.speechSynthesis.getVoices() || [];
  const exact = voices.find((v) => v.lang?.toLowerCase() === locale.toLowerCase());
  const loose = voices.find((v) => v.lang?.toLowerCase().startsWith(locale.slice(0, 2)));
  const chosen = exact || loose;
  if (chosen) utter.voice = chosen;
  else utter.lang = 'en-GB'; // no local voice installed; English beats silence
  utter.rate = 1.05;
  window.speechSynthesis.speak(utter);
}

export async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return false;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
    return true;
  } catch {
    return false;
  }
}

export function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

export function hasWakeLock() {
  return !!wakeLock;
}

// Re-acquire after the tab comes back to the foreground; browsers drop the lock.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && wakeLock === null && document.body.dataset.tracking === 'on') {
    requestWakeLock();
  }
});
