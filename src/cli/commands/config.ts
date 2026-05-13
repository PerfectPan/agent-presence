import { printConfigHelp } from '../help.js';
import { configureProvider } from './config-provider.js';
import { configureRender } from './config-render.js';
import { printConfig } from './config-show.js';

export async function configure(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'show';
  if (subcommand === 'show') {
    await printConfig();
    return;
  }
  if (subcommand === 'render' || subcommand === 'text') {
    await configureRender(args.slice(1));
    return;
  }
  if (subcommand === 'provider') {
    await configureProvider(args.slice(1));
    return;
  }
  printConfigHelp();
  process.exitCode = 1;
}
