#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const nodeCommand = process.execPath;
const serverEntry = path.join(process.cwd(), 'server', 'index.js');
const localBackendEntry = path.join(process.cwd(), 'scripts', 'start-backend-local-runtime.js');
const viteEntry = path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');
const shouldUseLocalBackendRuntime = process.env.PEPPRO_USE_LOCAL_BACKEND_RUNTIME === 'true';

if (shouldUseLocalBackendRuntime) {
  process.stdout.write(`[dev-full] backend runtime: local temp mirror\n`);
} else {
  process.stdout.write(`[dev-full] backend runtime: direct workspace\n`);
}

const children = new Set();
let shuttingDown = false;

const prefixOutput = (name, colorCode, stream, target, onLine) => {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (typeof onLine === 'function') {
        onLine(line);
      }
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

const spawnNamed = (name, colorCode, command, args, options = {}) => {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.add(child);
  prefixOutput(name, colorCode, child.stdout, process.stdout, options.onStdoutLine);
  prefixOutput(name, colorCode, child.stderr, process.stderr, options.onStderrLine);
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

let frontendStarted = false;
let backendReady = false;
let backendReadyTimer = null;

const startFrontend = () => {
  if (frontendStarted || shuttingDown) {
    return;
  }
  frontendStarted = true;
  process.stdout.write('[dev-full] starting frontend after backend boot\n');
  spawnNamed('frontend', 32, nodeCommand, [viteEntry]);
};

const markBackendReady = () => {
  if (backendReady) {
    return;
  }
  backendReady = true;
  if (backendReadyTimer) {
    clearTimeout(backendReadyTimer);
    backendReadyTimer = null;
  }
  startFrontend();
};

spawnNamed(
  'backend',
  34,
  nodeCommand,
  [shouldUseLocalBackendRuntime ? localBackendEntry : serverEntry],
  {
    onStdoutLine: (line) => {
      if (
        line.includes('[boot] listen:done')
        || line.includes('Backend server is ready')
      ) {
        markBackendReady();
      }
    },
  },
);

backendReadyTimer = setTimeout(() => {
  if (!backendReady) {
    process.stdout.write('[dev-full] backend readiness timeout; starting frontend anyway\n');
    startFrontend();
  }
}, 20000);

if (typeof backendReadyTimer.unref === 'function') {
  backendReadyTimer.unref();
}
