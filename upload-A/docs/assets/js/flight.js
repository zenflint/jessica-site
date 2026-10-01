// Scroll-driven fly-through.
// Scroll position (in viewport heights) → beat → frame, via the piecewise timeline in content/flight.json.
import { FrameStore } from './frames.js';

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (t) => t * t * (3 - 2 * t);

export function buildTimeline(beats, fps, count, { narrow = false } = {}) {
  const last = count - 1;
  const toFrame = (s) => Math.max(0, Math.min(last, Math.round(s * fps)));
  let pos = 0;
  const segs = beats.map((b) => {
    const len = narrow && b.vhMobile != null ? b.vhMobile : b.vh;
    const hold = b.at != null;
    const seg = {
      id: b.id,
      start: pos,
      end: pos + len,
      f0: toFrame(hold ? b.at : b.from),
      f1: toFrame(hold ? b.at : b.to),
      chapter: b.chapter || null,
      focus: b.focus ?? 0.5
    };
    pos += len;
    return seg;
  });

  // Chapters: consecutive beats with the same chapter form one range.
  const ranges = [];
  for (const s of segs) {
    const prev = ranges[ranges.length - 1];
    if (s.chapter && prev && prev.id === s.chapter && prev.end === s.start) prev.end = s.end;
    else if (s.chapter) ranges.push({ id: s.chapter, start: s.start, end: s.end });
  }
  return { segs, ranges, total: pos };
}

export function segAt(tl, p) {
  for (const s of tl.segs) if (p < s.end) return s;
  return tl.segs[tl.segs.length - 1];
}

export function frameAt(tl, p) {
  const s = segAt(tl, p);
  const t = s.end > s.start ? clamp01((p - s.start) / (s.end - s.start)) : 1;
  return s.f0 + (s.f1 - s.f0) * t;
}

// Horizontal crop focus, eased between beats so a shifted crop never jumps.
export function focusAt(tl, p) {
  const i = tl.segs.indexOf(segAt(tl, p));
  const s = tl.segs[i];
  const next = tl.segs[i + 1];
  if (!next || next.focus === s.focus) return s.focus;
  const span = Math.min(40, (s.end - s.start) / 2);
  const t = clamp01((p - (s.end - span)) / span);
  return s.focus + (next.focus - s.focus) * smooth(t);
}

export function chapterOpacity(range, p, fade, total) {
  const isFirst = range.start === 0;
  const isLast = range.end >= total;
  if (p < range.start && !isFirst) return 0;
  if (p > range.end && !isLast) return 0;
  const fin = isFirst ? 1 : clamp01((p - range.start) / fade);
  const fout = isLast ? 1 : clamp01((range.end - p) / fade);
  return smooth(Math.min(fin, fout));
}

export function prefersStatic() {
  const q = new URLSearchParams(location.search);
  if (q.has('motion')) return false;
  if (q.has('static')) return true;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
  const c = navigator.connection;
  if (c && (c.saveData || /(^|-)2g$/.test(c.effectiveType || ''))) return true;
  if (navigator.deviceMemory && navigator.deviceMemory <= 2) return true;
  return false;
}

export class Flight {
  constructor(section) {
    this.section = section;
    this.stage = section.querySelector('.flight__stage');
    this.canvas = section.querySelector('.flight__canvas');
    this.ctx = this.canvas.getContext('2d', { alpha: false });
    this.config = JSON.parse(section.querySelector('#flight-config').textContent);
    this.chapterEls = new Map(
      [...section.querySelectorAll('.chapter')].map((el) => [el.dataset.chapter, el])
    );
    this.railItems = new Map(
      [...section.querySelectorAll('[data-rail]')].map((el) => [el.dataset.rail, el])
    );
    this.railFill = section.querySelector('.rail');
    this.loadBar = section.querySelector('.flight__loading');
    this.target = 0;
    this.drawn = -1;
    this.lastP = 0;
    this.raf = 0;
    this.unit = window.innerHeight / 100;
    this.onScroll = () => this.update();
    this.onResize = () => this.layout();
  }

  async start() {
    if (prefersStatic()) return this.toStatic('preference');

    // Chapters are laid out with a provisional timeline until the manifest arrives.
    this.timeline = buildTimeline(this.config.beats, this.config.fps || 20, 100000, { narrow: this.isNarrow() });
    this.layout();
    window.addEventListener('scroll', this.onScroll, { passive: true });
    window.addEventListener('resize', this.onResize);
    this.update();

    let manifest;
    const manifestUrl = this.config.manifest;
    try {
      const r = await fetch(manifestUrl, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`manifest ${r.status}`);
      manifest = await r.json();
    } catch (err) {
      console.warn('[flight] falling back to stills:', err);
      return this.toStatic('manifest');
    }

    this.manifest = manifest;
    this.timeline = buildTimeline(this.config.beats, manifest.fps, manifest.count, { narrow: this.isNarrow() });
    this.store = new FrameStore(manifest, manifestUrl, {
      onReady: (i) => this.frameReady(i),
      onProgress: (f) => this.progress(f),
      onFatal: (err) => {
        console.warn('[flight] falling back to stills:', err);
        this.toStatic('frames');
      }
    });

    this.io = new IntersectionObserver(
      ([e]) => this.store && this.store.setActive(e.isIntersecting),
      { rootMargin: '100% 0px 100% 0px' }
    );
    this.io.observe(this.section);
    this.layout();
    this.update();
  }

  isNarrow() {
    return window.matchMedia('(max-width: 600px)').matches;
  }

  layout() {
    // On touch devices the viewport height changes as browser bars show/hide; ignore small changes.
    const h = window.innerHeight;
    const prev = this.unit * 100;
    const touch = matchMedia('(pointer: coarse)').matches;
    if (!touch || Math.abs(h - prev) > 120 || !this.laidOut) this.unit = h / 100;
    this.laidOut = true;

    if (this.manifest) {
      this.timeline = buildTimeline(this.config.beats, this.manifest.fps, this.manifest.count, { narrow: this.isNarrow() });
    }
    const tl = this.timeline;
    this.section.style.height = `${Math.round(tl.total * this.unit + this.unit * 100)}px`;
    this.stage.style.height = `${Math.round(this.unit * 100)}px`;

    // Place rail dots at the middle of each chapter's range.
    for (const r of tl.ranges) {
      const el = this.railItems.get(r.id);
      if (el && !el.dataset.placed) {
        const x = r.start === 0 ? 0 : r.end >= tl.total ? 100 : ((r.start + r.end) / 2 / tl.total) * 100;
        el.style.setProperty('--x', `${x}%`);
      }
    }

    // Canvas backing store = CSS size × device pixel ratio (capped at 2).
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.round(this.stage.clientWidth * dpr);
    const hh = Math.round(this.stage.clientHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== hh) {
      this.canvas.width = w;
      this.canvas.height = hh;
      this.drawn = -1;
    }
    this.update();
  }

  progressVh() {
    const top = this.section.getBoundingClientRect().top;
    const p = -top / this.unit;
    return Math.max(0, Math.min(this.timeline.total, p));
  }

  update() {
    if (!this.timeline || this.isStatic) return;
    const tl = this.timeline;
    const p = this.progressVh();
    const dir = p >= this.lastP ? 1 : -1;
    this.lastP = p;
    this.p = p;
    this.section.classList.toggle('is-ended', p >= tl.total - 1);

    if (this.store) {
      this.target = Math.round(frameAt(tl, p));
      this.store.want(this.target, dir);
    }

    // Chapters: fade in, hold, fade out within their beats. Hidden copy is inert.
    const opacity = new Map();
    for (const r of tl.ranges) {
      const o = chapterOpacity(r, p, this.config.fadeVh || 18, tl.total);
      opacity.set(r.id, Math.max(opacity.get(r.id) || 0, o));
    }
    for (const [id, el] of this.chapterEls) {
      const o = opacity.get(id) || 0;
      if (el._o === o) continue;
      el._o = o;
      el.style.opacity = o.toFixed(3);
      el.style.setProperty('--o', o.toFixed(3));
      const visible = o > 0.01;
      el.classList.toggle('is-visible', visible);
      el.inert = o < 0.5;
    }

    // Rail
    if (this.railFill) {
      this.railFill.style.setProperty('--p', (p / tl.total).toFixed(4));
      let current = null;
      for (const r of tl.ranges) if (p >= r.start - 1) current = r.id;
      for (const [id, el] of this.railItems) {
        const r = tl.ranges.find((x) => x.id === id);
        el.classList.toggle('is-current', id === current);
        el.classList.toggle('is-passed', !!r && p > r.start && id !== current);
      }
    }

    this.requestDraw();
  }

  frameReady(i) {
    // Redraw if the new frame is closer to what we want than what's on screen.
    if (this.drawn === this.target) return;
    if (this.drawn < 0 || Math.abs(i - this.target) < Math.abs(this.drawn - this.target)) this.requestDraw();
  }

  requestDraw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.draw();
    });
  }

  draw() {
    if (!this.store) return;
    const best = this.store.best(this.target);
    if (!best) return;
    const focus = focusAt(this.timeline, this.p || 0);
    if (best.index === this.drawn && focus === this.drawnFocus) return;

    // Cover fit: fill the stage and crop the overflow around the focus point.
    const { width: fw, height: fh } = best.bitmap;
    const cw = this.canvas.width, ch = this.canvas.height;
    const scale = Math.max(cw / fw, ch / fh);
    const dw = fw * scale, dh = fh * scale;
    const x = (cw - dw) * focus;
    const y = (ch - dh) / 2;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.ctx.drawImage(best.bitmap, x, y, dw, dh);
    this.drawn = best.index;
    this.drawnFocus = focus;
    if (!this.section.classList.contains('is-drawing')) this.section.classList.add('is-drawing');
  }

  progress(f) {
    if (this.loadBar) this.loadBar.style.setProperty('--loaded', f.toFixed(3));
    if (f >= 0.999) this.section.classList.add('is-loaded');
  }

  toStatic(reason) {
    this.isStatic = true;
    this.section.classList.add('flight--static');
    this.section.dataset.static = reason;
    this.section.style.height = '';
    this.stage.style.height = '';
    window.removeEventListener('scroll', this.onScroll);
    window.removeEventListener('resize', this.onResize);
    if (this.io) this.io.disconnect();
    if (this.store) { const s = this.store; this.store = null; s.destroy(); }
    for (const el of this.chapterEls.values()) {
      el.inert = false;
      el.style.opacity = '';
      el.style.removeProperty('--o');
    }
  }
}
