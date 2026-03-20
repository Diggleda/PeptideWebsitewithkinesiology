#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const nodeCommand = process.execPath;
const serverEntry = path.join(process.cwd(), 'server', 'index.js');
const viteEntry = path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');

const children = new Set();
let shuttingDown = false;

const prefixOutput = (name, colorCode, stream, target) => {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      const prefixed = `\u001b[${colorCode}m[${name}]\u001b[0m ${line}`;
      target.write(`${prefixed}\n`);
    }
  });
  stream.on('end', () => {
    if (!buffer) {
      return;
    }
    const prefixed = `\u001b[${colorCode}m[${name}]\u001b[0m ${buffer}`;
    target.write(`${prefixed}\n`);
    buffer = '';
  });
};

const terminateChildren = (signal = 'SIGTERM') => {
  for (const child of children) {
    if (!child.killed) {
      try {
        child.kill(signal);
      } catch {
        // ignore teardown failures
      }
    }
  }
};

const exitAll = (code) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  terminateChildren('SIGTERM');
  setTimeout(() => terminateChildren('SIGKILL'), 1500).unref();
  process.exit(code);
};

const spawnNamed = (name, colorCode, command, args) => {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  prefixOutput(name, colorCode, child.stdout, process.stdout);
  prefixOutput(name, colorCode, child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    children.delete(child);
    if (shuttingDown) {
      return;
    }
    if (signal) {
      process.stderr.write(`[${name}] exited via signal ${signal}\n`);
      exitAll(1);
      return;
    }
    if (code !== 0) {
      process.stderr.write(`[${name}] exited with code ${code}\n`);
      exitAll(code || 1);
      return;
    }
    exitAll(0);
  });
  child.on('error', (error) => {
    process.stderr.write(`[${name}] failed to start: ${error.message}\n`);
    exitAll(1);
  });
};

process.on('SIGINT', () => exitAll(130));
process.on('SIGTERM', () => exitAll(143));

spawnNamed('backend', 34, nodeCommand, [serverEntry]);
spawnNamed('frontend', 32, nodeCommand, [viteEntry]);
