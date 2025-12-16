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

  getDefaultValue() {
    const base = Array.isArray(this.defaultValue)
      ? [...this.defaultValue]
      : this.defaultValue;
    return this.cloneData(base);
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
        const initial = this.getDefaultValue();
        this.write(initial);
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

  extractFirstJsonValue(raw) {
    if (!raw || typeof raw !== 'string') {
      return null;
    }

    const start = raw.search(/\S/);
    if (start < 0) {
      return null;
    }
    const first = raw[start];
    const openChar = first === '{' || first === '[' ? first : null;
    const closeChar = first === '{' ? '}' : first === '[' ? ']' : null;
    if (!openChar || !closeChar) {
      return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < raw.length; i += 1) {
      const ch = raw[i];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (ch === '\\\\') {
          escaped = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }

      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === openChar) {
        depth += 1;
        continue;
      }
      if (ch === closeChar) {
        depth -= 1;
        if (depth === 0) {
          const slice = raw.slice(start, i + 1);
          try {
            return JSON.parse(slice);
          } catch (_error) {
            return null;
          }
        }
      }
    }

    return null;
  }

  readFromDisk() {
    const raw = fs.readFileSync(this.filePath, 'utf8');
    if (!raw) {
      return this.getDefaultValue();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      const recovered = this.extractFirstJsonValue(raw);
      if (recovered !== null) {
        logger.warn({ file: this.filePath }, 'Recovered JSON store from trailing/corrupt data; rewriting canonical file');
        parsed = recovered;
        try {
          this.write(parsed);
        } catch (writeError) {
          logger.warn({ err: writeError, file: this.filePath }, 'Failed to rewrite recovered JSON store');
        }
      } else {
        logger.error({ err: error, file: this.filePath }, 'JSON store is corrupted; renaming and serving default');
        try {
          const corruptPath = `${this.filePath}.corrupt.${Date.now()}`;
          fs.renameSync(this.filePath, corruptPath);
        } catch (_renameError) {
          // ignore rename failures
        }
        parsed = this.getDefaultValue();
        try {
          this.write(parsed);
        } catch (_writeError) {
          // ignore write failures; caller will still receive defaults
        }
      }
    }
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
        return this.getDefaultValue();
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
    let tmpPath = null;
    try {
      this.ensureDir();
      const payload = JSON.stringify(data, null, 2);
      tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmpPath, payload, 'utf8');
      try {
        const fd = fs.openSync(tmpPath, 'r');
        try {
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
      } catch (_error) {
        // Best-effort fsync; ignore on unsupported filesystems.
      }
      fs.renameSync(tmpPath, this.filePath);
      this.cache = data;
      try {
        this.cacheMtimeMs = fs.statSync(this.filePath).mtimeMs;
      } catch (_error) {
        this.cacheMtimeMs = Date.now();
      }
    } catch (error) {
      try {
        if (tmpPath && fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch (_cleanupError) {
        // ignore cleanup failures
      }
      logger.error({ err: error, file: this.filePath }, 'Failed to write store');
      throw error;
    }
  }
}

module.exports = { JsonStore };
