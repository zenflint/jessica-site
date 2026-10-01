// FrameStore — loads an image sequence around the frame the visitor needs now.
//
// Two tiers keep memory bounded:
//   blobs   — compressed WebP bytes (small), kept for a wide window
//   bitmaps — decoded ImageBitmaps (large), kept only for a narrow window and closed on eviction
// Requests are prioritised: the target frame first, then frames ahead in the scroll
// direction, then a few behind. Obsolete requests are aborted on fast jumps.
//
// Frames can be stored one per file, or packed into sprite sheets (manifest.sheet = { cols, rows, pattern })
// for hosts that limit the number of files. Downloads work in "units" — a frame, or a whole sheet — and a
// sheet is decoded once and cut into its frames.

const pad = (n, width) => String(n).padStart(width, '0');

export class FrameStore {
  constructor(manifest, manifestUrl, opts = {}) {
    this.count = manifest.count;
    this.fps = manifest.fps;
    this.width = manifest.width;
    this.height = manifest.height;
    this.version = manifest.version || '1';
    this.pattern = manifest.pattern;
    this.base = new URL(manifest.dir || './', new URL(manifestUrl, document.baseURI));
    this.sheet = manifest.sheet || null;
    this.perUnit = this.sheet ? this.sheet.cols * this.sheet.rows : 1;
    this.unitCount = Math.ceil(this.count / this.perUnit);

    this.concurrency = opts.concurrency ?? 6;
    this.ahead = opts.ahead ?? 36; // high-priority window in the scroll direction
    this.behind = opts.behind ?? 10;
    this.prefetch = opts.prefetch ?? 240; // background window once the near window is satisfied
    this.maxBlobs = opts.maxBlobs ?? this.unitCount;
    this.maxBitmaps = opts.maxBitmaps ?? 28;
    this.decodeAhead = opts.decodeAhead ?? 8;
    this.decodeBehind = opts.decodeBehind ?? 3;
    this.decodeWidth = opts.decodeWidth || 0; // optional downscale at decode time
    this.maxAttempts = 3;

    this.onReady = opts.onReady || (() => {});
    this.onProgress = opts.onProgress || (() => {});
    this.onFatal = opts.onFatal || (() => {});

    this.blobs = new Map(); //    unit → compressed bytes
    this.bitmaps = new Map(); //  frame → decoded bitmap
    this.inflight = new Map(); // unit → AbortController
    this.decoding = new Set();
    this.fails = new Map();
    this.consecutiveFails = 0;
    this.target = 0;
    this.dir = 1;
    this.active = true;
    this.dead = false;
    this.retryTimer = 0;
  }

  unit(i) {
    return Math.floor(i / this.perUnit);
  }

  // Frames in priority order → the units that hold them, in the same order.
  units(frames) {
    if (!this.sheet) return frames;
    const seen = new Set();
    for (const i of frames) seen.add(this.unit(i));
    return [...seen];
  }

  url(u) {
    const pattern = this.sheet ? this.sheet.pattern : this.pattern;
    const name = pattern.replace(/%0(\d+)d/, (_, w) => pad(u, +w));
    return `${new URL(name, this.base).href}?v=${encodeURIComponent(this.version)}`;
  }

  clamp(i) {
    return Math.max(0, Math.min(this.count - 1, i));
  }

  want(target, dir) {
    this.target = this.clamp(target);
    if (dir) this.dir = dir > 0 ? 1 : -1;
    this.pump();
  }

  setActive(active) {
    this.active = active;
    if (!active) {
      // Keep the near window, drop background work.
      const near = new Set(this.units(this.nearWindow()));
      for (const [i, ctl] of this.inflight) if (!near.has(i)) { ctl.abort(); this.inflight.delete(i); }
    }
    this.pump();
  }

  // The frames needed soon, in priority order.
  nearWindow() {
    const t = this.target, d = this.dir;
    const list = [t];
    for (let k = 1; k <= this.ahead; k++) {
      list.push(t + d * k);
      if (k <= this.behind) list.push(t - d * k);
    }
    return list.filter((i) => i >= 0 && i < this.count);
  }

  // Wider, lower-priority window: ahead first, then behind.
  farWindow() {
    const t = this.target, d = this.dir;
    const list = [];
    for (let k = this.ahead + 1; k <= this.prefetch; k++) list.push(t + d * k);
    for (let k = this.behind + 1; k <= this.prefetch / 3; k++) list.push(t - d * k);
    return list.filter((i) => i >= 0 && i < this.count);
  }

  missing(u) {
    return !this.blobs.has(u) && !this.inflight.has(u) && (this.fails.get(u) || 0) < this.maxAttempts;
  }

  pump() {
    if (this.dead) return;
    const near = this.units(this.nearWindow());
    const nearSet = new Set(near);
    const nearMissing = near.some((u) => !this.blobs.has(u));
    const targetUnit = this.unit(this.target);

    // Abort requests that no longer matter when the near window still needs bandwidth.
    if (nearMissing) {
      for (const [u, ctl] of this.inflight) {
        if (!nearSet.has(u)) { ctl.abort(); this.inflight.delete(u); }
      }
    }

    for (const u of near) {
      if (this.inflight.size >= this.concurrency) break;
      if (this.missing(u)) this.fetchUnit(u, u === targetUnit ? 'high' : 'auto');
    }

    if (this.active && !nearMissing && this.inflight.size < this.concurrency) {
      for (const u of this.units(this.farWindow())) {
        if (this.inflight.size >= this.concurrency) break;
        if (this.blobs.size >= this.maxBlobs) break;
        if (this.missing(u)) this.fetchUnit(u, 'low');
      }
    }

    this.decodeAround();
  }

  fetchUnit(u, priority) {
    const ctl = new AbortController();
    this.inflight.set(u, ctl);
    fetch(this.url(u), { signal: ctl.signal, priority })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.blob();
      })
      .then((blob) => {
        this.blobs.set(u, blob);
        this.fails.delete(u);
        this.consecutiveFails = 0;
        this.evictBlobs();
        this.onProgress(this.blobs.size / this.unitCount);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        this.fails.set(u, (this.fails.get(u) || 0) + 1);
        this.consecutiveFails++;
        if (this.consecutiveFails >= Math.min(24, this.unitCount) && this.blobs.size === 0) {
          this.fail(new Error('Frames could not be loaded'));
          return;
        }
        // Bounded retry with backoff.
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.pump(), 300 * (this.fails.get(u) || 1));
      })
      .finally(() => {
        if (this.inflight.get(u) === ctl) this.inflight.delete(u);
        if (!this.dead) this.pump();
      });
  }

  decodeAround() {
    const t = this.target, d = this.dir;
    const order = [t];
    for (let k = 1; k <= this.decodeAhead; k++) {
      order.push(t + d * k);
      if (k <= this.decodeBehind) order.push(t - d * k);
    }
    // If the target itself isn't available yet, decode the nearest downloaded frame so something close is on screen.
    if (!this.blobs.has(this.unit(t)) && !this.bitmaps.has(t)) {
      const n = this.nearestLoaded(t);
      if (n != null) order.unshift(n);
    }
    for (const i of order) {
      if (this.decoding.size >= 4) break;
      if (i < 0 || i >= this.count) continue;
      if (this.bitmaps.has(i) || this.decoding.has(i) || !this.blobs.has(this.unit(i))) continue;
      if (this.sheet) this.decodeSheet(this.unit(i), i);
      else this.decode(i);
    }
  }

  decode(i) {
    this.decoding.add(i);
    const blob = this.blobs.get(i);
    const opts = this.decodeWidth && this.decodeWidth < this.width
      ? { resizeWidth: this.decodeWidth, resizeHeight: Math.round((this.decodeWidth / this.width) * this.height), resizeQuality: 'high' }
      : undefined;
    const run = opts ? createImageBitmap(blob, opts).catch(() => createImageBitmap(blob)) : createImageBitmap(blob);
    run
      .then((bmp) => {
        if (this.dead) { bmp.close(); return; }
        this.bitmaps.set(i, bmp);
        this.evictBitmaps();
        this.onReady(i);
      })
      .catch(() => {
        // A corrupt frame: drop the bytes so it can be refetched once.
        this.blobs.delete(i);
        this.fails.set(i, (this.fails.get(i) || 0) + 1);
      })
      .finally(() => {
        this.decoding.delete(i);
        if (!this.dead) this.decodeAround();
      });
  }

  // Decode a whole sheet once and cut it into frame bitmaps (cropping a decoded bitmap is cheap).
  decodeSheet(u, requested) {
    const first = u * this.perUnit;
    const frames = [];
    for (let k = 0; k < this.perUnit && first + k < this.count; k++) frames.push(first + k);
    for (const f of frames) this.decoding.add(f);
    const { cols } = this.sheet;
    const w = this.width, h = this.height;
    const opts = this.decodeWidth && this.decodeWidth < w
      ? { resizeWidth: this.decodeWidth, resizeHeight: Math.round((this.decodeWidth / w) * h), resizeQuality: 'high' }
      : {};
    createImageBitmap(this.blobs.get(u))
      .then((sheet) => Promise.all(frames.map((f) => {
        const k = f - first;
        return createImageBitmap(sheet, (k % cols) * w, Math.floor(k / cols) * h, w, h, opts);
      })).finally(() => sheet.close()))
      .then((bmps) => {
        if (this.dead) { bmps.forEach((b) => b.close()); return; }
        bmps.forEach((b, k) => {
          const f = frames[k];
          if (this.bitmaps.has(f)) this.bitmaps.get(f).close();
          this.bitmaps.set(f, b);
        });
        this.evictBitmaps();
        this.onReady(requested);
      })
      .catch(() => {
        this.blobs.delete(u);
        this.fails.set(u, (this.fails.get(u) || 0) + 1);
      })
      .finally(() => {
        for (const f of frames) this.decoding.delete(f);
        if (!this.dead) this.decodeAround();
      });
  }

  evictBitmaps() {
    if (this.bitmaps.size <= this.maxBitmaps) return;
    const t = this.target;
    const byDistance = [...this.bitmaps.keys()].sort((a, b) => Math.abs(b - t) - Math.abs(a - t));
    while (this.bitmaps.size > this.maxBitmaps) {
      const i = byDistance.shift();
      this.bitmaps.get(i).close();
      this.bitmaps.delete(i);
    }
  }

  evictBlobs() {
    if (this.blobs.size <= this.maxBlobs) return;
    const t = this.unit(this.target);
    const byDistance = [...this.blobs.keys()].sort((a, b) => Math.abs(b - t) - Math.abs(a - t));
    while (this.blobs.size > this.maxBlobs) this.blobs.delete(byDistance.shift());
  }

  // Nearest frame whose bytes are downloaded.
  nearestLoaded(t) {
    const has = (i) => i >= 0 && i < this.count && this.blobs.has(this.unit(i));
    for (let k = 0; k < this.count; k++) {
      if (has(t - k)) return t - k;
      if (has(t + k)) return t + k;
      if (t - k < 0 && t + k >= this.count) break;
    }
    return null;
  }

  nearestIn(map, t) {
    if (map.has(t)) return t;
    for (let k = 1; k < this.count; k++) {
      if (map.has(t - k)) return t - k;
      if (map.has(t + k)) return t + k;
      if (t - k < 0 && t + k >= this.count) break;
    }
    return null;
  }

  // Best bitmap to show for the target: exact, else the nearest decoded one.
  best(t) {
    const i = this.nearestIn(this.bitmaps, t);
    return i == null ? null : { index: i, bitmap: this.bitmaps.get(i) };
  }

  fail(err) {
    if (this.dead) return;
    this.onFatal(err);
    this.destroy();
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.retryTimer);
    for (const ctl of this.inflight.values()) ctl.abort();
    this.inflight.clear();
    for (const bmp of this.bitmaps.values()) bmp.close();
    this.bitmaps.clear();
    this.blobs.clear();
  }
}
