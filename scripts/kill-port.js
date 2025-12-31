#!/usr/bin/env node
/**
 * Kill any process using the specified port.
 * Usage: node scripts/kill-port.js 3000
 */

const { execSync } = require('child_process');

const port = process.argv[2] || 3000;

try {
  // Find process ID using the port
  const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8', stdio: 'pipe' });
  const pids = result.trim().split('\n').filter(Boolean);

  if (pids.length > 0) {
    console.log(`Found ${pids.length} process(es) on port ${port}: ${pids.join(', ')}`);

    // Kill each process
    pids.forEach(pid => {
      try {
        execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
        console.log(`Killed process ${pid} on port ${port}`);
      } catch (err) {
        console.error(`Failed to kill process ${pid}:`, err.message);
      }
    });
  } else {
    console.log(`No process found on port ${port}`);
  }
} catch (error) {
  // lsof returns exit code 1 if no process found, which is fine
  if (error.status === 1) {
    console.log(`Port ${port} is available`);
  } else {
    console.error(`Error checking port ${port}:`, error.message);
  }
}
