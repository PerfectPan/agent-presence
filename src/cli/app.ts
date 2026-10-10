import { parseArgs } from './args.js';
import { printHelp } from './help.js';
import { writeHookLoadFailure } from './hook-output.js';
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

  // Command implementations load lazily so a hook run never loads the setup,
  // installer, and login modules; the hook path's static graph must stay free
  // of them (guarded by test/hook-graph.test.ts).
  switch (parsed.command) {
    case 'login': {
      const { login } = await import('./commands/login.js');
      await login(parsed.args);
      return;
    }
    case 'setup': {
      const { setup } = await import('./commands/setup.js');
      await setup(parsed.args);
      return;
    }
    case 'uninstall': {
      const { uninstall } = await import('./commands/uninstall.js');
      await uninstall(parsed.args);
      return;
    }
    case 'url': {
      const { printSignatureUrl } = await import('./commands/url.js');
      await printSignatureUrl(parsed.args);
      return;
    }
    case 'config': {
      const { configure } = await import('./commands/config.js');
      await configure(parsed.args);
      return;
    }
    case 'source': {
      const { source } = await import('./commands/source.js');
      await source(parsed.args);
      return;
    }
    case 'status': {
      const { printStatus } = await import('./commands/status.js');
      await printStatus(parsed.args);
      return;
    }
    case 'usage': {
      const { printUsage } = await import('./commands/usage.js');
      await printUsage(parsed.args);
      return;
    }
    case 'update': {
      const { update } = await import('./commands/update.js');
      await update(parsed.args);
      return;
    }
    case 'flush': {
      const { flush } = await import('./commands/flush.js');
      await flush(parsed.args);
      return;
    }
    case 'reset': {
      const { reset } = await import('./commands/reset.js');
      await reset(parsed.args);
      return;
    }
    case 'hook': {
      // A rejected load of the hook command module fails open exactly like a
      // failure inside it: same log line, same hook output, exit code 0.
      try {
        const { hook } = await import('./commands/hook.js');
        await hook(parsed.args);
      } catch (error) {
        await writeHookLoadFailure(parsed.args, error);
      }
      return;
    }
  }

  printHelp();
  process.exitCode = 1;
}
