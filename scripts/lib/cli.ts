/** Presentation plumbing the scripts under `scripts/` share: the exit handler and the dsh patch report. */

/** Run a script's `main`: when it rejects, print the error's message and exit 1. */
export function runScriptMain(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

/** Report the dsh patch update both `install-dsh-plugin` and `uninstall-dsh-plugin` print after their action. */
export function reportDshPatchOutcome(result: { patchUpdated: boolean; patchPath: string; patchError?: string }): void {
  if (result.patchUpdated) {
    console.log(`updated dsh patch: ${result.patchPath}`);
  } else if (result.patchError) {
    console.warn(`warning: could not update dsh patch at ${result.patchPath}: ${result.patchError}`);
  }
}
