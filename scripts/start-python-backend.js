const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const port = String(process.env.PORT || '3001').trim() || '3001';
const env = {
  ...process.env,
  PORT: port,
};

const candidates = [
  process.env.PYTHON_BIN,
  path.join(rootDir, '.venv', 'bin', 'python3'),
  path.join(rootDir, '.venv', 'bin', 'python'),
  'python3',
  'python',
].filter(Boolean);

const findPythonCommand = () => {
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate.includes(path.sep) && !fs.existsSync(candidate)) {
      continue;
    }
    return candidate;
  }
  return null;
};

const pythonBin = findPythonCommand();

if (!pythonBin) {
  console.error('Unable to find a Python interpreter. Set PYTHON_BIN or create .venv/.');
  process.exit(1);
}

const args = ['-m', 'flask', '--app', 'python_backend.wsgi:app', 'run', '--debug', '--host', '0.0.0.0', '--port', port];

const child = spawn(pythonBin, args, {
  cwd: rootDir,
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

