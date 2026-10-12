// Stand-ins for the browser's speech APIs, used by test/run.js (headless Chromium has no real microphone or voices).
// - SpeechRecognition: each start() plays the next step of window.__srScript: { text } (heard, first part as an
//   interim result, then the whole as final) or { error: 'not-allowed' | 'network' | 'no-speech' ... }.
//   Every start() is recorded in window.__srStarts with its language.
// - speechSynthesis: speak() "says" the text (start, then end after a few ms per character) and records it in
//   window.__spoken; cancel() interrupts what is playing.
(function () {
  window.__srScript = window.__srScript || [];
  window.__srStarts = [];
  class FakeRecognition {
    constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; this.maxAlternatives = 1; this._timers = []; this._ended = false; }
    _later(fn, ms) { this._timers.push(setTimeout(fn, ms)); }
    _end() { if (this._ended) return; this._ended = true; this._timers.forEach(clearTimeout); if (this.onend) this.onend({}); }
    start() {
      const step = window.__srScript.shift() || { error: 'no-speech' };
      window.__srStarts.push({ lang: this.lang, interim: this.interimResults });
      const res = (t, fin) => { const alt = { transcript: t, confidence: 0.9 }; const r = [alt]; r.isFinal = fin; return r; };
      if (step.error) { this._later(() => { if (this.onerror) this.onerror({ error: step.error }); this._end(); }, 30); return; }
      const half = step.text.split(' ').slice(0, Math.ceil(step.text.split(' ').length / 2)).join(' ');
      this._later(() => { if (this.onresult) this.onresult({ resultIndex: 0, results: [res(half, false)] }); }, 40);
      this._later(() => { if (this.onresult) this.onresult({ resultIndex: 0, results: [res(step.text, true)] }); }, step.hold || 90);
      this._later(() => this._end(), (step.hold || 90) + 30);
    }
    stop() { this._later(() => this._end(), 10); }
    abort() { if (this.onerror) this.onerror({ error: 'aborted' }); this._later(() => this._end(), 5); }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;

  window.__spoken = [];
  let current = null;
  class FakeUtterance { constructor(text) { this.text = String(text); this.rate = 1; this.lang = ''; this.voice = null; this.volume = 1; } }
  const synth = {
    speaking: false,
    getVoices: () => [{ name: 'Test Voice', lang: 'en-US', voiceURI: 'test-en-us', default: true }],
    speak(u) {
      if (current) this.cancel();
      const rec = { u, timers: [] };
      current = rec;
      if (u.text.trim()) window.__spoken.push({ text: u.text, rate: u.rate });
      rec.timers.push(setTimeout(() => { this.speaking = true; if (u.onstart) u.onstart({}); }, 5));
      rec.timers.push(setTimeout(() => { if (current === rec) current = null; this.speaking = false; if (u.onend) u.onend({}); }, 20 + u.text.length * 4 / (u.rate || 1)));
    },
    cancel() {
      const rec = current; current = null; this.speaking = false;
      if (!rec) return;
      rec.timers.forEach(clearTimeout);
      if (rec.u.onerror) rec.u.onerror({ error: 'interrupted' });
    },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = FakeUtterance;
})();
