#!/usr/bin/env node

const { execSync } = require('child_process');
const path = require('path');

const repoRoot = process.cwd();
const normalizedRepoRoot = repoRoot.replace(/\s+/g, ' ').trim();
const selfPid = process.pid;
const parentPid = process.ppid;

const isKillableRepoProcess = (command) => {
  if (!command) {
    return false;
  }

  const normalized = command.replace(/\s+/g, ' ').trim();
  if (!normalized.includes(normalizedRepoRoot)) {
    return false;
  }

  return [
    'node server/index.js',
    'node scripts/build-frontend.js',
    'node_modules/.bin/vite',
    'node_modules/.bin/concurrently',
    'npm run dev',
    'npm run dev:full',
    'npm run server',
  ].some((token) => normalized.includes(token));
};

const listProcesses = () => {
  const output = execSync('ps -axo pid=,command=', {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(.+)$/);
      if (!match) {
        return null;
      }
      return {
        pid: Number.parseInt(match[1], 10),
        command: match[2],
      };
    })
    .filter(Boolean);
};

const killPid = (pid, signal) => {
  execSync(`kill -${signal} ${pid}`, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
};

try {
  const candidates = listProcesses().filter(({ pid, command }) => (
    Number.isFinite(pid)
    && pid !== selfPid
    && pid !== parentPid
    && isKillableRepoProcess(command)
  ));

  if (candidates.length === 0) {
    console.log('No stale repo dev/build processes found');
    process.exit(0);
  }

  console.log(`Found ${candidates.length} stale repo process(es): ${candidates.map(({ pid }) => pid).join(', ')}`);

  candidates.forEach(({ pid, command }) => {
    try {
      killPid(pid, '9');
      console.log(`Killed process ${pid}: ${command}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to kill process ${pid}: ${message}`);
    }
  });
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Failed to scan repo processes: ${message}`);
  process.exit(1);
}
