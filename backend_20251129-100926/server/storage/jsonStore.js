const fs = require('fs');
const path = require('path');
const { logger } = require('../config/logger');

class JsonStore {
  constructor(baseDir, fileName, defaultValue = []) {
    this.baseDir = baseDir;
    this.fileName = fileName;
    this.defaultValue = defaultValue;
    this.filePath = path.join(baseDir, fileName);
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
        fs.writeFileSync(
          this.filePath,
          JSON.stringify(this.defaultValue, null, 2),
          'utf8',
        );
      }
    } catch (error) {
      logger.error({ err: error, file: this.filePath }, 'Failed to initialize store');
      throw error;
    }
  }

  read() {
    try {
      this.ensureDir();
      if (!fs.existsSync(this.filePath)) {
        return Array.isArray(this.defaultValue)
          ? [...this.defaultValue]
          : this.defaultValue;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw) {
        return Array.isArray(this.defaultValue)
          ? [...this.defaultValue]
          : this.defaultValue;
      }
      return JSON.parse(raw);
    } catch (error) {
      logger.error({ err: error, file: this.filePath }, 'Failed to read store');
      throw error;
    }
  }

  write(data) {
    try {
      this.ensureDir();
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
      logger.error({ err: error, file: this.filePath }, 'Failed to write store');
      throw error;
    }
  }
}

module.exports = { JsonStore };
