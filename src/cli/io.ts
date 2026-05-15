export { writeLog } from '../log.js';

export async function readStdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) {
    return {};
  }

  try {
    let raw = '';
    for await (const chunk of process.stdin) {
      raw += chunk;
    }
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}
