'use strict';
/**
 * Tiny dependency-free JSON store (replaces electron-store).
 * Writes are debounced and atomic (write temp file, then rename).
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

class Store {
  constructor(name, defaults = {}) {
    this.file = path.join(app.getPath('userData'), `${name}.json`);
    this.defaults = defaults;
    this.data = {};
    this._timer = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = parsed;
    } catch { /* first run or corrupted file: start from defaults */ }
  }

  has(key) { return this.data[key] !== undefined; }

  get(key, fallback) {
    const v = this.data[key];
    if (v !== undefined) return v;
    if (fallback !== undefined) return fallback;
    return clone(this.defaults[key]);
  }

  set(key, value) {
    this.data[key] = value;
    this._schedule();
  }

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 400);
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('[store] write failed:', e.message);
    }
  }
}

module.exports = Store;
