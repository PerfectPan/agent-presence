import * as z from 'zod/mini';
import { loadConfig, type AppConfig } from './config.js';

// Commands, the queue worker and the takeover parse the config here, so one broken entry is ignored with a warning
// that names it instead of breaking them. The hook path keeps the schema-free read in `src/config.ts`: loading zod
// costs a hook about 22 ms (Plan 0003 3.2, test/hook-graph.test.ts), and the hook reads only its own source's entry
// and fails open on that entry and on a null root, as before.

/** A config value the loader dropped, named by its path in the config file. */
export interface ConfigIssue {
  /** The dropped value's path, for example `plugins.sources.x` or `render.one`. */
  path: string;
  /** Why the value does not parse, for example `expected an object`. */
  reason: string;
}

/** The reason one zod issue names, in the wording of the loader's warnings; a union names its first branch. */
function reasonForIssue(issue: z.core.$ZodIssue): string {
  if (issue.code === 'invalid_type' && typeof issue.expected === 'string') {
    const expected = issue.expected === 'record' ? 'object' : issue.expected;
    return `expected ${/^[aeiou]/.test(expected) ? 'an' : 'a'} ${expected}`;
  }
  if (issue.code === 'invalid_union') {
    const branch = issue.errors[0]?.[0];
    if (branch) {
      return reasonForIssue(branch);
    }
  }
  return issue.message || issue.code;
}

/** The reason of the first issue zod raised, in the wording of the loader's warnings. */
function droppedValueReason(error: z.core.$ZodError): string {
  const issue = error.issues[0];
  return issue ? reasonForIssue(issue) : 'invalid';
}

/**
 * A number, or the decimal numeric strings the readers accept today through arithmetic coercion (`ttlMs: "300000"`
 * in `expireStaleSessions`, prices in `resolveRecordCost`); loads as the number.
 */
const numberLike = z.union([
  z.number(),
  z.pipe(
    z.string().check(z.regex(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/)),
    z.transform((text) => Number(text))
  )
]);

/**
 * A boolean, or the `1`/`true` (or `0`/`false`) strings the accessor's own env override has always accepted for
 * `usage.showInSignature`; loads as the boolean.
 */
const booleanLike = z.union([
  z.boolean(),
  z.pipe(
    z.string().check(z.regex(/^(?:1|true|0|false)$/i)),
    z.transform((text) => text === '1' || text.toLowerCase() === 'true')
  )
]);

/** A string, or a number the credential store stringifies (`slot_id: 123` names slot `"123"`); loads as the string. */
const stringLike = z.union([z.string(), z.pipe(z.number(), z.transform(String))]);

/**
 * A known config field: parses, or loads as missing with its path reported. `z.optional` wraps the pipe, so an
 * absent key stays absent and only a present value can be dropped.
 */
function configField<S extends z.ZodMiniType>(path: string, schema: S, issues: ConfigIssue[]) {
  return z.optional(
    z.pipe(
      z.unknown(),
      z.transform((value): z.output<S> | undefined => {
        const parsed = schema.safeParse(value);
        if (parsed.success) {
          return parsed.data;
        }
        issues.push({ path, reason: droppedValueReason(parsed.error) });
        return undefined;
      })
    )
  );
}

/**
 * A schema that parses `schema` and, when the value does not conform, reports it under `path` and yields
 * `fallback` — the root's "a non-object loads as `{}`".
 */
function parseOrDrop<S extends z.ZodMiniType>(path: string, schema: S, issues: ConfigIssue[], fallback: z.output<S>) {
  return z.pipe(
    z.unknown(),
    z.transform((value) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        return parsed.data;
      }
      issues.push({ path, reason: droppedValueReason(parsed.error) });
      return fallback;
    })
  );
}

/**
 * A string-keyed map whose entries that do not parse are dropped, so one bad entry loses only itself. The entry
 * schema is built per key, so a dropped value inside an entry is reported under its full path.
 */
function entriesThatParse<S extends z.ZodMiniType>(prefix: string, entry: (key: string) => S, issues: ConfigIssue[]) {
  return z.pipe(
    z.record(z.string(), z.unknown()),
    z.transform((entries) => {
      const parsed: Record<string, z.output<S>> = {};
      for (const [key, value] of Object.entries(entries)) {
        const result = entry(key).safeParse(value);
        if (result.success) {
          parsed[key] = result.data;
        } else {
          issues.push({ path: `${prefix}.${key}`, reason: droppedValueReason(result.error) });
        }
      }
      return parsed;
    })
  );
}

/**
 * The whole config file. Every object is loose, so keys the schema does not know are kept: the file is the user's.
 * Objects only reachable through a map build per key, so their fields' issue paths name the entry.
 */
function configSchema(issues: ConfigIssue[]) {
  const matchField = (prefix: string) =>
    z.looseObject({
      envKeys: configField(`${prefix}.envKeys`, z.array(z.string()), issues),
      payloadKeys: configField(`${prefix}.payloadKeys`, z.array(z.string()), issues),
      nestedPayloadKeys: configField(`${prefix}.nestedPayloadKeys`, z.array(z.string()), issues),
      payloadFirst: configField(`${prefix}.payloadFirst`, z.boolean(), issues)
    });

  const matchSpec = (prefix: string) =>
    z.looseObject({
      sessionId: configField(`${prefix}.sessionId`, matchField(`${prefix}.sessionId`), issues),
      project: configField(`${prefix}.project`, matchField(`${prefix}.project`), issues),
      event: configField(`${prefix}.event`, matchField(`${prefix}.event`), issues)
    });

  const sourceEntry = (prefix: string) =>
    z.looseObject({
      handler: configField(`${prefix}.handler`, z.string(), issues),
      match: configField(`${prefix}.match`, matchSpec(`${prefix}.match`), issues),
      enabled: configField(`${prefix}.enabled`, z.boolean(), issues)
    });

  const priceEntry = (prefix: string) =>
    z.looseObject({
      input: configField(`${prefix}.input`, numberLike, issues),
      output: configField(`${prefix}.output`, numberLike, issues),
      cacheWrite: configField(`${prefix}.cacheWrite`, numberLike, issues),
      cacheWrite1h: configField(`${prefix}.cacheWrite1h`, numberLike, issues),
      cacheRead: configField(`${prefix}.cacheRead`, numberLike, issues)
    });

  return z.looseObject({
    provider: configField(
      'provider',
      z.enum(['feishu-signature', 'magic-builder', 'l-garyyang'], { error: 'expected a known provider id' }),
      issues
    ),
    providerBaseUrl: configField('providerBaseUrl', z.string(), issues),
    previewBaseUrl: configField('previewBaseUrl', z.string(), issues),
    previewImageKey: configField('previewImageKey', z.string(), issues),
    previewTargetUrl: configField('previewTargetUrl', z.string(), issues),
    providers: configField(
      'providers',
      z.looseObject({
        'feishu-signature': configField(
          'providers.feishu-signature',
          z.looseObject({
            baseUrl: configField('providers.feishu-signature.baseUrl', z.string(), issues),
            previewBaseUrl: configField('providers.feishu-signature.previewBaseUrl', z.string(), issues),
            previewImageKey: configField('providers.feishu-signature.previewImageKey', z.string(), issues),
            previewTargetUrl: configField('providers.feishu-signature.previewTargetUrl', z.string(), issues)
          }),
          issues
        ),
        'magic-builder': configField(
          'providers.magic-builder',
          z.looseObject({
            baseUrl: configField('providers.magic-builder.baseUrl', z.string(), issues),
            faasId: configField('providers.magic-builder.faasId', z.string(), issues),
            faasName: configField('providers.magic-builder.faasName', z.string(), issues),
            fallbackTitle: configField('providers.magic-builder.fallbackTitle', z.string(), issues)
          }),
          issues
        )
      }),
      issues
    ),
    slot_id: configField('slot_id', stringLike, issues),
    slotId: configField('slotId', stringLike, issues),
    ttlMs: configField('ttlMs', numberLike, issues),
    debounceMs: configField('debounceMs', numberLike, issues),
    render: configField(
      'render',
      z.looseObject({
        zero: configField('render.zero', z.string(), issues),
        one: configField('render.one', z.string(), issues),
        many: configField('render.many', z.string(), issues)
      }),
      issues
    ),
    usage: configField(
      'usage',
      z.looseObject({
        showInSignature: configField('usage.showInSignature', booleanLike, issues),
        signatureWindowDays: configField('usage.signatureWindowDays', numberLike, issues),
        pricing: configField(
          'usage.pricing',
          entriesThatParse('usage.pricing', (model) => priceEntry(`usage.pricing.${model}`), issues),
          issues
        )
      }),
      issues
    ),
    plugins: configField(
      'plugins',
      z.looseObject({
        sources: configField(
          'plugins.sources',
          entriesThatParse('plugins.sources', (id) => sourceEntry(`plugins.sources.${id}`), issues),
          issues
        )
      }),
      issues
    )
  });
}

type ConfigSchemaOutput = z.output<ReturnType<typeof configSchema>>;
/** Strips the string index signature a loose object's output carries, so the known keys compare exactly. */
type KnownKeys<T> = { [K in keyof T as string extends K ? never : K]: T[K] };
type Expect<T extends true> = T;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type ConfigSchemaKeysMatchAppConfig = Equal<keyof KnownKeys<ConfigSchemaOutput>, keyof AppConfig>;
type ConfigSchemaOutputIsAppConfig = ConfigSchemaOutput extends AppConfig ? true : false;

/**
 * Fails to compile when the schema drifts from `AppConfig`: a missing or extra known field, or a field whose
 * parsed type the accessors in `src/config.ts` would read differently.
 */
export type ConfigSchemaMatchesAppConfig = Expect<
  Equal<[ConfigSchemaKeysMatchAppConfig, ConfigSchemaOutputIsAppConfig], [true, true]>
>;

/** Parse the config file's content: dropped values reported, unknown keys kept, a non-object root loaded as `{}`. */
export function parseConfigFile(raw: unknown): { config: AppConfig; issues: ConfigIssue[] } {
  const issues: ConfigIssue[] = [];
  const parsed = parseOrDrop('config', configSchema(issues), issues, {}).safeParse(raw);
  // The pipe catches every failure, so the parse succeeds; the branch narrows `data`.
  if (!parsed.success) {
    return { config: {}, issues };
  }
  const config: AppConfig = parsed.data;
  return { config, issues };
}

export interface ValidatedConfigLoad {
  /** The config as it loads: a value that does not parse loads as missing, unknown keys are kept. */
  readonly config: AppConfig;
  /**
   * The file's content as read without the schema, and the base every write command changes and saves back: a
   * command keeps the keys and entries it does not touch. A dropped root (not an object) leaves nothing to keep, so
   * this is `{}` there — always an object, never the bare file value.
   */
  readonly raw: AppConfig;
  /** Each dropped value, with its path and reason, in schema order. */
  readonly issues: ConfigIssue[];
}

export interface LoadValidatedConfigOptions {
  /** The config file to read; the standard path (with its legacy fallback) by default. */
  readonly configPath?: string;
  /** Print each dropped value once per process on stderr; the worker passes false to drop silently. */
  readonly report?: boolean;
}

// Issue keys this process has already printed, so a run that loads the config several times — a command, then the
// takeover that applies its pending records — prints each dropped value once.
const reportedIssues = new Set<string>();

function reportDroppedValues(issues: ConfigIssue[]): void {
  for (const issue of issues) {
    const key = `${issue.path}: ${issue.reason}`;
    if (reportedIssues.has(key)) {
      continue;
    }
    reportedIssues.add(key);
    console.error(`config: ignored ${issue.path} (${issue.reason})`);
  }
}

/** Load the config for commands, the worker and the takeover: the validated view plus, for writes, the raw file. */
export async function loadValidatedConfig(options: LoadValidatedConfigOptions = {}): Promise<ValidatedConfigLoad> {
  const file = await loadConfig(options.configPath);
  const { config, issues } = parseConfigFile(file);
  if (options.report !== false) {
    reportDroppedValues(issues);
  }
  // Only a dropped root has no file content to write over; its issue is the one named `config`.
  const raw = issues.some((issue) => issue.path === 'config') ? {} : file;
  return { config, raw, issues };
}

/** The `plugins.sources` table as the file holds it, however broken its entries are. */
const rawSourcesTable = z.record(z.string(), z.unknown());

/**
 * Whether the file's `plugins.sources` table holds the key `id` at all — the presence test for `source remove`,
 * which must also remove an entry the loader dropped. A table that is not a map holds no keys.
 */
export function hasPluginSource(config: AppConfig, id: string): boolean {
  const parsed = rawSourcesTable.safeParse(config.plugins?.sources);
  return parsed.success && id in parsed.data;
}
