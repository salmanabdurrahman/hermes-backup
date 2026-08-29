#!/usr/bin/env node
import { runCli } from './src/index.js';

runCli(process.argv.slice(2))
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error('[ERROR] Fatal CLI execution error:', err);
    process.exit(1);
  });
