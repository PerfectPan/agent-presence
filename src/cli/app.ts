import { parseArgs } from './args.js';
import { configure } from './commands/config.js';
import { hook } from './commands/hook.js';
import { login } from './commands/login.js';
import { reset } from './commands/reset.js';
import { setup } from './commands/setup.js';
import { printStatus } from './commands/status.js';
import { uninstall } from './commands/uninstall.js';
import { update } from './commands/update.js';
import { printUsage } from './commands/usage.js';
import { printSignatureUrl } from './commands/url.js';
import { printHelp } from './help.js';
import { assertSupportedPlatform } from '../platform.js';

export async function runCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);

  switch (parsed.command) {
    case undefined:
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      assertSupportedPlatform();
      break;
  }

  switch (parsed.command) {
    case 'login':
      await login(parsed.args);
      return;
    case 'setup':
      await setup(parsed.args);
      return;
    case 'uninstall':
      await uninstall(parsed.args);
      return;
    case 'url':
      await printSignatureUrl(parsed.args);
      return;
    case 'config':
      await configure(parsed.args);
      return;
    case 'status':
      await printStatus(parsed.args);
      return;
    case 'usage':
      await printUsage(parsed.args);
      return;
    case 'update':
      await update(parsed.args);
      return;
    case 'reset':
      await reset(parsed.args);
      return;
    case 'hook':
      await hook(parsed.args);
      return;
  }

  printHelp();
  process.exitCode = 1;
}
