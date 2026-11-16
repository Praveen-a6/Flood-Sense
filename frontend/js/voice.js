// Voice guidance with the browser's built-in speech engine (works offline
// on most Android phones and on Windows/macOS with installed voices).
let enabled = true;

export function setVoice(on) { enabled = on; if (!on) stop(); }
export function voiceAvailable() { return "speechSynthesis" in window; }

function pickVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang === "en-IN") || voices.find((v) => v.lang.startsWith("en")) || null;
}

export function speak(text) {
  if (!enabled || !voiceAvailable()) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  const v = pickVoice();
  if (v) u.voice = v;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

export function stop() { if (voiceAvailable()) speechSynthesis.cancel(); }
