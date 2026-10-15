import { inspect } from 'node:util';
import { HarnessLive, type HarnessServices } from '@rivus/agent-kit/harness';
import { NodePlatformLive } from '@rivus/agent-kit/node/effect';
import { Effect, Exit, Layer } from 'effect';

const harnessLayer = HarnessLive.pipe(Layer.provideMerge(NodePlatformLive));

export async function runHarness<A, E>(
  program: Effect.Effect<A, E, HarnessServices>,
  layer: Layer.Layer<HarnessServices> = harnessLayer
): Promise<A | undefined> {
  const exit = await Effect.runPromiseExit(program.pipe(Effect.provide(layer)));
  if (Exit.isFailure(exit)) {
    for (const reason of exit.cause.reasons) {
      switch (reason._tag) {
        case 'Fail':
          console.error(inspect(reason.error, { depth: null, colors: false }));
          break;
        case 'Die':
          console.error(inspect(reason.defect, { depth: null, colors: false }));
          break;
        case 'Interrupt':
          console.error('Harness operation interrupted');
          break;
      }
    }
    process.exitCode = 1;
    return undefined;
  }
  return exit.value;
}
