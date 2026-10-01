// Runs the API server and the Vite dev server together; Ctrl+C stops both.
import { spawn } from 'node:child_process';

const procs = [
  spawn('node', ['--watch', 'server/server.js'], { stdio: 'inherit' }),
  spawn('npx', ['vite', '--host'], { stdio: 'inherit' }),
];
const stop = () => procs.forEach((p) => p.kill());
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
procs.forEach((p) => p.on('exit', stop));
