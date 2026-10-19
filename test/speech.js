// Stand-ins for the browser's speech APIs, used by test/run.js (headless Chromium has no real microphone or voices).
// - SpeechRecognition: each start() plays the next step of window.__srScript: { text, wait, hold } (the first half
//   as an interim result after wait ms, 40 by default, the whole as final after hold ms, 90 by default; stop()
//   before that returns the half as final) or { error: 'not-allowed' | 'network' | 'no-speech' ... }. An empty
//   script means no-speech. { interimOnly: 'uh', wait, hold }: an interim result only, then the recognition ends
//   without confirming it (a recogniser that never confirms its last guess); with blank: true the guess is taken
//   back first (a short noise briefly guessed at).
//   Every start() is recorded in window.__srStarts with its language.
// - speechSynthesis: speak() "says" the text (start, then end after a few ms per character) and records it in
//   window.__spoken; cancel() interrupts what is playing. With window.__ttsDrop set, no events reach the page
//   (speaking still goes back to false at the end), like some Chrome voices.
// - window.__speechLog lists what happened in order: 'say:<text>', 'said', 'cut' (speech) and 'listen', 'heard:<text>',
//   'stop-listen' (recognition), so a test can check that the microphone never listened while a voice was speaking.
(function () {
  window.__srScript = window.__srScript || [];
  window.__srStarts = [];
  window.__speechLog = [];
  const log = s => window.__speechLog.push(s);
  const res = (t, fin) => { const alt = { transcript: t, confidence: 0.9 }; const r = [alt]; r.isFinal = fin; return r; };
  class FakeRecognition {
    constructor() { this.lang = ''; this.interimResults = false; this.continuous = false; this.maxAlternatives = 1; this._timers = []; this._ended = false; this._partial = ''; }
    _later(fn, ms) { this._timers.push(setTimeout(fn, ms)); }
    _end() { if (this._ended) return; this._ended = true; this._timers.forEach(clearTimeout); log('stop-listen'); if (this.onend) this.onend({}); }
    start() {
      const step = window.__srScript.shift() || { error: 'no-speech' };
      window.__srStarts.push({ lang: this.lang, interim: this.interimResults });
      log('listen' + (synth.speaking ? '-while-speaking' : ''));
      if (step.error) { this._later(() => { if (this.onerror) this.onerror({ error: step.error }); this._end(); }, 30); return; }
      if (step.interimOnly) {
        this._later(() => { this._partial = step.interimOnly; if (this.onresult) this.onresult({ resultIndex: 0, results: [res(step.interimOnly, false)] }); }, step.wait || 40);
        // blank: the guess is taken back (an empty result) before the end.
        this._later(() => { this._partial = ''; if (step.blank && this.onresult) this.onresult({ resultIndex: 0, results: [] }); this._end(); }, (step.hold || 90) + 30);
        return;
      }
      const half = step.text.split(' ').slice(0, Math.ceil(step.text.split(' ').length / 2)).join(' ');
      const hold = step.hold || 90;
      this._later(() => { this._partial = half; if (this.onresult) this.onresult({ resultIndex: 0, results: [res(half, false)] }); }, step.wait || 40);
      this._later(() => { this._partial = ''; log('heard:' + step.text); if (this.onresult) this.onresult({ resultIndex: 0, results: [res(step.text, true)] }); }, hold);
      this._later(() => this._end(), hold + 30);
    }
    // stop() keeps what was heard so far (it comes back as the final result); abort() drops it.
    stop() {
      if (this._ended) return;
      const t = this._partial; this._partial = '';
      this._timers.forEach(clearTimeout); this._timers = [];
      this._later(() => { if (t) { log('heard:' + t); if (this.onresult) this.onresult({ resultIndex: 0, results: [res(t, true)] }); } this._end(); }, 10);
    }
    abort() { this._partial = ''; if (this.onerror) this.onerror({ error: 'aborted' }); this._later(() => this._end(), 5); }
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
      if (u.text.trim()) { window.__spoken.push({ text: u.text, rate: u.rate }); log('say:' + u.text); }
      this.speaking = true;
      // window.__ttsDrop: like some Chrome voices, the speech plays but no start or end event ever reaches the page.
      const drop = !!window.__ttsDrop;
      rec.timers.push(setTimeout(() => { if (u.onstart && !drop) u.onstart({}); }, 5));
      rec.timers.push(setTimeout(() => { if (current === rec) current = null; this.speaking = false; if (u.text.trim()) log('said'); if (u.onend && !drop) u.onend({}); }, 20 + u.text.length * 4 / (u.rate || 1)));
    },
    cancel() {
      const rec = current; current = null; this.speaking = false;
      if (!rec) return;
      rec.timers.forEach(clearTimeout);
      if (rec.u.text.trim()) log('cut');
      if (rec.u.onerror && !window.__ttsDrop) rec.u.onerror({ error: 'interrupted' });
    },
    addEventListener() {}, removeEventListener() {},
  };
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = FakeUtterance;
})();
