#!/usr/bin/env node
import { runCli } from './cli/app.js';
import { errorMessage } from './cli/errors.js';

runCli(process.argv.slice(2)).catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
