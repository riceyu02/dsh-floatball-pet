'use strict';
/** Tiny JSON-file preference store for the pet's geometry and appearance. */
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  ballSize: 56,
  opacity: 1,
  centerX: null,
  centerY: null,
  // Keep the island unfolded instead of opening it on hover.
  islandPinned: false,
  // Absolute path to a custom ball image (static or animated GIF). null = built-in art.
  ballImage: null,
  showBalance: true,
  showUptime: true,
};

class Store {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.data = { ...DEFAULTS, ...parsed };
    } catch {
      /* first run — keep defaults */
    }
    return this.data;
  }

  save(patch) {
    if (patch) Object.assign(this.data, patch);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error('[pet] could not persist preferences:', error.message);
    }
    return this.data;
  }
}

module.exports = { Store, DEFAULTS };
