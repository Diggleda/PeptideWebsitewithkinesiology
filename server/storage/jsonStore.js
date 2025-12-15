const fs = require('fs');
const path = require('path');
const { logger } = require('../config/logger');

class JsonStore {
  constructor(baseDir, fileName, defaultValue = []) {
    this.baseDir = baseDir;
    this.fileName = fileName;
    this.defaultValue = defaultValue;
    this.filePath = path.join(baseDir, fileName);
    this.cache = null;
    this.cacheMtimeMs = 0;
  }

  ensureDir() {
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  init() {
    try {
      this.ensureDir();
      if (!fs.existsSync(this.filePath)) {
        const initial = Array.isArray(this.defaultValue)
          ? [...this.defaultValue]
          : this.defaultValue;
        fs.writeFileSync(
          this.filePath,
          JSON.stringify(initial, null, 2),
          'utf8',
        );
        this.cache = initial;
        this.cacheMtimeMs = fs.statSync(this.filePath).mtimeMs;
      }
    } catch (error) {
      logger.error({ err: error, file: this.filePath }, 'Failed to initialize store');
      throw error;
    }
  }

  cloneData(data) {
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (_error) {
      return data;
    }
  }

  readFromDisk() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw) {
      return Array.isArray(this.defaultValue)
        ? [...this.defaultValue]
        : this.defaultValue;
    }
    const parsed = JSON.parse(raw);
    this.cache = parsed;
    try {
      this.cacheMtimeMs = fs.statSync(this.filePath).mtimeMs;
    } catch (_error) {
      this.cacheMtimeMs = Date.now();
    }
    return parsed;
  }

  read() {
    try {
      this.ensureDir();
      if (!fs.existsSync(this.filePath)) {
        return Array.isArray(this.defaultValue)
          ? [...this.defaultValue]
          : this.defaultValue;
      }

      if (this.cache !== null) {
        try {
          const stat = fs.statSync(this.filePath);
          if (stat.mtimeMs === this.cacheMtimeMs) {
            return this.cloneData(this.cache);
          }
        } catch (_error) {
          // If stat fails, fall back to disk read.
        }
      }

      const data = this.readFromDisk();
      return this.cloneData(data);
    } catch (error) {
      logger.error({ err: error, file: this.filePath }, 'Failed to read store');
      throw error;
    }
  }

  write(data) {
    try {
      this.ensureDir();
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
      this.cache = data;
      try {
        this.cacheMtimeMs = fs.statSync(this.filePath).mtimeMs;
      } catch (_error) {
        this.cacheMtimeMs = Date.now();
      }
    } catch (error) {
      logger.error({ err: error, file: this.filePath }, 'Failed to write store');
      throw error;
    }
  }
}

module.exports = { JsonStore };
