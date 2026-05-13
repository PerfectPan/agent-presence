import { cancel, intro, isCancel, note, outro, spinner, text } from '@clack/prompts';

interface SpinnerLike {
  start(message?: string): void;
  stop(message?: string): void;
  error(message?: string): void;
  clear(): void;
}

interface TextPromptOptions {
  message: string;
  placeholder?: string;
  initialValue?: string;
  defaultValue?: string;
  validate?: (value: string | undefined) => string | Error | undefined;
}

export function isInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && process.env.CI !== 'true' && process.env.AGENT_PRESENCE_NO_PROMPTS !== '1');
}

export function startIntro(title: string): void {
  if (isInteractiveTerminal()) {
    intro(title);
  } else {
    console.log(title);
  }
}

export function finishOutro(message: string): void {
  if (isInteractiveTerminal()) {
    outro(message);
  } else {
    console.log(message);
  }
}

export function showNote(message: string, title?: string): void {
  if (isInteractiveTerminal()) {
    note(message, title);
    return;
  }

  if (title) {
    console.log(`${title}:`);
  }
  console.log(message);
}

export function showInfo(message: string): void {
  console.log(message);
}

export function showSuccess(message: string): void {
  console.log(message);
}

export function showWarning(message: string): void {
  console.warn(message);
}

export function createSpinner(): SpinnerLike {
  if (isInteractiveTerminal()) {
    return spinner();
  }

  return {
    start(message?: string): void {
      if (message) {
        console.log(message);
      }
    },
    stop(message?: string): void {
      if (message) {
        console.log(message);
      }
    },
    error(message?: string): void {
      if (message) {
        console.error(message);
      }
    },
    clear(): void {}
  };
}

export async function promptText(options: TextPromptOptions): Promise<string> {
  const value = await text(options);
  if (isCancel(value)) {
    cancel('cancelled');
    throw new Error('operation cancelled');
  }
  return value;
}
