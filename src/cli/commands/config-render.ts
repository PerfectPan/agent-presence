import { getConfigPath, loadConfig, renderTemplates, saveConfig } from '../../config.js';
import { hasAnyOption, hasFlag, optionValue } from '../args.js';
import { isInteractiveTerminal, promptText } from '../ui.js';

const RENDER_OPTIONS = ['--zero', '--one', '--many'];

export async function configureRender(args: string[]): Promise<void> {
  const config = await loadConfig();
  const reset = hasFlag(args, '--reset');
  const nextConfig = { ...config };
  const nextRender = reset ? {} : { ...(config.render ?? {}) };

  if (!reset && isInteractiveTerminal() && !hasAnyOption(args, RENDER_OPTIONS)) {
    const current = renderTemplates(config);
    setOptionalTemplate(nextRender, 'zero', await promptTemplate('0 agents copy', current.zero));
    setOptionalTemplate(nextRender, 'one', await promptTemplate('1 agent copy', current.one));
    setOptionalTemplate(nextRender, 'many', await promptTemplate('N agents copy', current.many));
  } else {
    setOptionalTemplate(nextRender, 'zero', optionValue(args, '--zero'));
    setOptionalTemplate(nextRender, 'one', optionValue(args, '--one'));
    setOptionalTemplate(nextRender, 'many', optionValue(args, '--many'));
  }

  if (Object.keys(nextRender).length > 0) {
    nextConfig.render = nextRender;
  } else {
    delete nextConfig.render;
  }

  await saveConfig(nextConfig, getConfigPath());
  console.log(
    JSON.stringify(
      {
        status: 'updated',
        render: renderTemplates(nextConfig),
        variables: ['{total}', '{details}']
      },
      null,
      2
    )
  );
}

async function promptTemplate(message: string, initialValue?: string): Promise<string | undefined> {
  const value = await promptText({
    message,
    initialValue,
    placeholder: initialValue,
    validate: (input) => {
      if (!input?.trim()) {
        return 'template cannot be empty';
      }
      return undefined;
    }
  });
  return value;
}

function setOptionalTemplate(target: Record<string, string>, key: string, value: string | undefined): void {
  if (value !== undefined) {
    target[key] = value;
  }
}
