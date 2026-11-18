// @ts-check
/**
 * Waveform overview with a movable analysis region.
 */
import { waveformPeaks } from '../audio/decode.js';

export class WaveformView {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {(regionStartSec: number) => void} onSeek called with the new region start
   */
  constructor(canvas, onSeek) {
    this.canvas = canvas;
    this.onSeek = onSeek;
    /** @type {Float32Array | null} */
    this.peaks = null;
    this.duration = 0;
    this.region = { start: 0, end: 0 };
    this.playhead = -1;
    canvas.addEventListener('click', (ev) => {
      if (!this.duration) return;
      const rect = canvas.getBoundingClientRect();
      const t = ((ev.clientX - rect.left) / rect.width) * this.duration;
      const len = this.region.end - this.region.start;
      this.onSeek(Math.max(0, Math.min(this.duration - len, t - len / 2)));
    });
    new ResizeObserver(() => this.draw()).observe(canvas);
  }

  /** @param {Float32Array} samples @param {number} sr */
  setAudio(samples, sr) {
    this.duration = samples.length / sr;
    this.peaks = waveformPeaks(samples, 1200);
    this.draw();
  }

  /** @param {number} start seconds @param {number} end seconds */
  setRegion(start, end) {
    this.region = { start, end };
    this.draw();
  }

  /** @param {number} t seconds, -1 to hide */
  setPlayhead(t) {
    this.playhead = t;
    this.draw();
  }

  draw() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(c.clientWidth * dpr));
    const hgt = Math.max(1, Math.round(c.clientHeight * dpr));
    if (c.width !== w || c.height !== hgt) {
      c.width = w;
      c.height = hgt;
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--accent').trim() || '#ff4d6d';
    const muted = css.getPropertyValue('--muted').trim() || '#888';
    ctx.clearRect(0, 0, w, hgt);
    if (!this.peaks || !this.duration) return;
    const rs = (this.region.start / this.duration) * w;
    const re = (this.region.end / this.duration) * w;
    ctx.fillStyle = accent;
    ctx.globalAlpha = 0.14;
    ctx.fillRect(rs, 0, re - rs, hgt);
    ctx.globalAlpha = 1;
    const buckets = this.peaks.length / 2;
    let max = 0.001;
    for (let i = 0; i < this.peaks.length; i++) max = Math.max(max, Math.abs(this.peaks[i]));
    const mid = hgt / 2;
    for (let x = 0; x < w; x++) {
      const b = Math.min(buckets - 1, Math.floor((x / w) * buckets));
      const mn = this.peaks[b * 2] / max;
      const mx = this.peaks[b * 2 + 1] / max;
      ctx.fillStyle = x >= rs && x <= re ? accent : muted;
      ctx.globalAlpha = x >= rs && x <= re ? 0.95 : 0.45;
      ctx.fillRect(x, mid - mx * mid * 0.92, 1, Math.max(1, (mx - mn) * mid * 0.92));
    }
    ctx.globalAlpha = 1;
    ctx.strokeStyle = accent;
    ctx.lineWidth = Math.max(1, dpr);
    ctx.strokeRect(rs + 0.5, 0.5, re - rs - 1, hgt - 1);
    if (this.playhead >= 0) {
      const px = (this.playhead / this.duration) * w;
      ctx.fillStyle = css.getPropertyValue('--text').trim() || '#fff';
      ctx.fillRect(px, 0, Math.max(1, dpr), hgt);
    }
  }
}
