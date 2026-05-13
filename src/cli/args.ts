export interface ParsedArgs {
  command?: string;
  args: string[];
}

export function parseArgs(args: string[]): ParsedArgs {
  return {
    command: args[0],
    args: args.slice(1)
  };
}

export function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  return args[index + 1];
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

export function hasAnyOption(args: string[], names: string[]): boolean {
  return names.some((name) => args.includes(name));
}
