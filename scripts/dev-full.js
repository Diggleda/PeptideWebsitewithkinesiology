#!/usr/bin/env node

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const nodeCommand = process.execPath;
const serverEntry = path.join(process.cwd(), 'server', 'index.js');
const localBackendEntry = path.join(process.cwd(), 'scripts', 'start-backend-local-runtime.js');
const viteEntry = path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');
const requestedLocalRuntime = process.env.PEPPRO_USE_LOCAL_BACKEND_RUNTIME;
const shouldUseLocalBackendRuntime = requestedLocalRuntime === 'true';

if (shouldUseLocalBackendRuntime) {
  process.stdout.write(`[dev-full] backend runtime: local temp mirror\n`);
} else {
  process.stdout.write(`[dev-full] backend runtime: direct workspace\n`);
}

const children = new Set();
let shuttingDown = false;
let selectedBackendPort = null;

const readTextFileWithRetry = (targetPath, attempts = 6) => {
  let lastError = null;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return fs.readFileSync(targetPath, 'utf8');
    } catch (error) {
      lastError = error;
      const code = typeof error?.code === 'string' ? error.code : '';
      if (!['ECANCELED', 'ETIMEDOUT', 'EAGAIN'].includes(code) || index === attempts - 1) {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120 * (index + 1));
    }
  }
  throw lastError;
};

const loadFrontendEnv = () => {
  const loaded = {};
  for (const fileName of ['.env', '.env.local']) {
    const filePath = path.join(process.cwd(), fileName);
    if (!fs.existsSync(filePath)) {
      continue;
    }
    try {
      const raw = readTextFileWithRetry(filePath);
      const parsed = dotenv.parse(raw);
      Object.assign(loaded, parsed);
    } catch (error) {
      process.stderr.write(`[dev-full] failed to preload ${fileName}: ${error.message}\n`);
    }
  }
  return loaded;
};

const safeExec = (command) => {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (typeof error?.stdout === 'string') {
      return error.stdout;
    }
    return '';
  }
};

const listPortPids = (port) => safeExec(`lsof -ti:${port}`)
  .split('\n')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value));

const commandForPid = (pid) => safeExec(`ps -p ${pid} -o command=`)
  .trim();

const isPepProBackendCommand = (command) => {
  if (!command) {
    return false;
  }
  return command.includes(path.join(process.cwd(), 'server', 'index.js'))
    || command.includes('node server/index.js')
    || command.includes('node scripts/dev-full.js')
    || command.includes(path.join(process.cwd(), 'scripts', 'dev-full.js'))
    || command.includes('peppro-backend-runtime/server/index.js');
};

const isPepProFrontendCommand = (command) => {
  if (!command) {
    return false;
  }
  return command.includes(path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js'))
    || command.includes('node_modules/vite/bin/vite.js')
    || command.includes('node scripts/dev-full.js')
    || command.includes(path.join(process.cwd(), 'scripts', 'dev-full.js'));
};

const cleanupStalePorts = () => {
  const portMatchers = [
    { port: 3000, matches: isPepProFrontendCommand, label: 'frontend' },
    { port: 3001, matches: isPepProBackendCommand, label: 'backend' },
    { port: 3002, matches: isPepProBackendCommand, label: 'backend' },
  ];
  for (const { port, matches, label } of portMatchers) {
    for (const pid of listPortPids(port)) {
      if (pid === process.pid || pid === process.ppid) {
        continue;
      }
      const command = commandForPid(pid);
      if (!matches(command)) {
        continue;
      }
      try {
        process.stdout.write(`[dev-full] clearing stale ${label} on :${port} (pid ${pid})\n`);
        process.kill(pid, 'SIGKILL');
      } catch {
        // ignore cleanup failures
      }
    }
  }
};

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
    env: {
      ...process.env,
      ...(options.env || {}),
    },
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

cleanupStalePorts();

let frontendStarted = false;
let backendReady = false;
let backendReadyTimer = null;

const startFrontend = () => {
  if (frontendStarted || shuttingDown) {
    return;
  }
  frontendStarted = true;
  const frontendEnv = {
    ...loadFrontendEnv(),
    PEPPRO_VITE_SKIP_ENV_FILES: 'true',
  };
  if (selectedBackendPort) {
    frontendEnv.VITE_API_URL = `http://localhost:${selectedBackendPort}`;
  }
  process.stdout.write(
    `[dev-full] starting frontend after backend boot`
      + (selectedBackendPort ? ` (api http://localhost:${selectedBackendPort})` : '')
      + '\n',
  );
  spawnNamed('frontend', 32, nodeCommand, [viteEntry], { env: frontendEnv });
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
      const portMatch = line.match(/\[boot\] listen:done \{ port: (\d+) \}/);
      if (portMatch) {
        selectedBackendPort = Number.parseInt(portMatch[1], 10);
      }
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
