import { spawn } from 'node:child_process';

// Producers start workers too (Plan 0003 3.3), so this module stays on the hook path's side: it imports no schema and
// nothing that does.

/** Starts a worker for this process's state file; tests start workers in process instead. */
export type StartWorker = () => void;

/**
 * Start `agent-presence worker` as a detached process of this release (`process.argv[1]`, as the deferred flush does)
 * with this process's environment, so every worker runs with the environment of the hook or command whose run started
 * it, passed on unchanged by a worker that starts another (Plan 0003 3.9). A worker that cannot be started leaves the
 * records for the next producer, which tries again (3.10).
 */
export const startWorkerProcess: StartWorker = () => {
  const cliPath = process.argv[1];
  if (!cliPath) {
    return;
  }
  try {
    const child = spawn(process.execPath, [cliPath, 'worker'], { detached: true, env: process.env, stdio: 'ignore' });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // The records wait for the next producer or command.
  }
};
