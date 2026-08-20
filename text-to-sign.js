export class TextToSignSynthesizer {
  constructor(signsData, videoElement, statusElement) {
    this.dictionary = signsData?.vocabulary ?? [];
    this.videoElement = videoElement;
    this.statusElement = statusElement;
    this.playbackQueue = [];
    this.currentIndex = 0;
    this.playbackSpeed = 1;
    this.skipTimer = null;

    this.videoElement?.addEventListener('ended', () => this.playNext());
    this.videoElement?.addEventListener('error', () => {
      this.setStatus('Video unavailable — moving to the next token');
      this.scheduleNext(900);
    });
  }

  normalizeText(rawText) {
    return String(rawText ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  translateText(rawText) {
    const normalized = this.normalizeText(rawText);
    if (!normalized) {
      this.playbackQueue = [];
      return [];
    }

    const words = normalized.split(' ');
    const queue = [];
    let index = 0;

    while (index < words.length) {
      let match = null;
      let matchedLength = 0;

      for (let length = Math.min(4, words.length - index); length >= 1; length--) {
        const phrase = words.slice(index, index + length).join(' ');
        const item = this.dictionary.find((entry) =>
          entry.tokens?.includes(phrase) || entry.gloss?.toLowerCase().replaceAll('_', ' ') === phrase
        );
        if (item) {
          match = item;
          matchedLength = length;
          break;
        }
      }

      if (match) {
        queue.push({
          gloss: match.gloss,
          sourceText: words.slice(index, index + matchedLength).join(' '),
          videoUrl: match.videoUrl,
          found: true,
          demoVideo: Boolean(match.demoVideo)
        });
        index += matchedLength;
      } else {
        queue.push({
          gloss: words[index].toUpperCase(),
          sourceText: words[index],
          videoUrl: null,
          found: false,
          demoVideo: false
        });
        index += 1;
      }
    }

    this.stop();
    this.playbackQueue = queue;
    this.currentIndex = 0;
    return queue;
  }

  playQueue() {
    if (!this.playbackQueue.length) {
      this.setStatus('Nothing to play');
      return;
    }
    this.currentIndex = 0;
    this.loadCurrentSign();
  }

  loadCurrentSign() {
    clearTimeout(this.skipTimer);
    const current = this.playbackQueue[this.currentIndex];
    if (!current) return;

    const prefix = `Token ${this.currentIndex + 1}/${this.playbackQueue.length}: ${current.gloss}`;
    if (!current.found || !current.videoUrl || !this.videoElement) {
      this.setStatus(`${prefix} · no mapped clip`);
      this.scheduleNext(1000);
      return;
    }

    this.setStatus(`${prefix}${current.demoVideo ? ' · DEMO clip' : ''}`);
    this.videoElement.src = current.videoUrl;
    this.videoElement.playbackRate = this.playbackSpeed;
    this.videoElement.currentTime = 0;
    this.videoElement.play().catch(() => {
      this.setStatus(`${prefix} · press Play if autoplay is blocked`);
    });
  }

  scheduleNext(delay) {
    clearTimeout(this.skipTimer);
    this.skipTimer = setTimeout(() => this.playNext(), delay);
  }

  playNext() {
    clearTimeout(this.skipTimer);
    if (this.currentIndex + 1 < this.playbackQueue.length) {
      this.currentIndex += 1;
      this.loadCurrentSign();
    } else {
      this.setStatus('Playback complete');
    }
  }

  stop() {
    clearTimeout(this.skipTimer);
    if (this.videoElement) {
      this.videoElement.pause();
      this.videoElement.removeAttribute('src');
      this.videoElement.load();
    }
  }

  setSpeed(speed) {
    const parsed = Number(speed);
    this.playbackSpeed = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    if (this.videoElement) this.videoElement.playbackRate = this.playbackSpeed;
  }

  setStatus(text) {
    if (this.statusElement) this.statusElement.textContent = text;
  }
}
