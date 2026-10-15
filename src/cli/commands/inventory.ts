import { inventory } from '@rivus/agent-kit/harness';
import { hasFlag } from '../args.js';
import { runHarness } from '../harness.js';

export async function printInventory(args: string[]): Promise<void> {
  const result = await runHarness(inventory());
  if (result === undefined) {
    return;
  }
  if (hasFlag(args, '--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Ledger revision: ${result.revision}`);
  console.log(`Entries (${result.entries.length}):`);
  for (const entry of result.entries) {
    console.log(JSON.stringify(entry, null, 2));
  }
  console.log(`Pending operations (${result.pending.length}):`);
  for (const operation of result.pending) {
    console.log(JSON.stringify(operation, null, 2));
  }
}
