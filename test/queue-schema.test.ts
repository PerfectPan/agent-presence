import { describe, expect, it } from 'vite-plus/test';
import {
  parseQueueApplied,
  parseQueueOwed,
  parseQueueRecord,
  readRecordVersion,
  type QueueOwed
} from '../src/queue/schema.js';

const header = { v: 1, id: '1760000000000-42-ab12', recordedAt: 1_760_000_000_000, epoch: 0 };

const eventRecord = {
  ...header,
  kind: 'event',
  source: 'claude',
  event: 'SessionStart',
  sessionId: 's1',
  project: '/work/repo',
  subagent: { id: 'a1', type: 'explore' },
  scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/.claude' },
  payloadKeys: ['hook_event_name', 'session_id']
};
const dshEventRecord = {
  ...header,
  kind: 'event',
  source: 'dsh',
  event: 'Stop',
  sessionId: 's2',
  usage: {
    source: 'dsh',
    model: 'deepseek-v4-pro',
    timestamp: 1_760_000_000_000,
    inputTokens: 900,
    outputTokens: 100,
    cacheWriteTokens: 0,
    cacheReadTokens: 2000
  },
  payloadKeys: ['model', 'usage']
};
const skipRecord = {
  ...header,
  kind: 'skip',
  code: 'no-presence-source',
  agent: 'cursor',
  nativeEvent: 'stop',
  payloadKeys: ['hook_event_name']
};
const errorRecord = { ...header, kind: 'error', code: 'resolver-failed', source: 'codex', message: 'resolver threw' };

function without(record: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

describe('readRecordVersion', () => {
  it('reads a non-negative integer v and nothing else', () => {
    expect(readRecordVersion({ v: 0 })).toBe(0);
    expect(readRecordVersion({ v: 7, kind: 'from-a-later-release', anything: [1, 2] })).toBe(7);
  });

  it.each([[{}], [{ v: -1 }], [{ v: 1.5 }], [{ v: '1' }], [null], [[1]], ['{"v":1}']])(
    'finds no version in %j',
    (raw) => {
      expect(readRecordVersion(raw)).toBeUndefined();
    }
  );
});

describe('parseQueueRecord', () => {
  it.each([
    ['event', eventRecord],
    ['dsh usage event', dshEventRecord],
    ['skip', skipRecord],
    ['skip with a code of a later release, which an older applier only logs', { ...skipRecord, code: 'later-code' }],
    ['error', errorRecord]
  ])('parses a valid %s record', (_name, raw) => {
    expect(parseQueueRecord(raw)).toEqual({ ok: true, record: raw });
  });

  it('keeps unknown fields of the usage and scanEnv a record carries, for the owed entries made from them', () => {
    const raw = {
      ...dshEventRecord,
      usage: { ...dshEventRecord.usage, costUsd: 0.25 },
      scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/.claude', LATER_HOME: '/fake-home/later' }
    };
    const parsed = parseQueueRecord(raw);
    expect(parsed.ok && parsed.record.kind === 'event' && parsed.record.usage).toEqual(raw.usage);
    expect(parsed.ok && parsed.record.kind === 'event' && parsed.record.scanEnv).toEqual(raw.scanEnv);
  });

  it.each([
    ['an unknown kind', { ...header, kind: 'later-kind' }],
    ['no kind', without(errorRecord, 'kind')],
    ['an event without a session id', without(eventRecord, 'sessionId')],
    ['an event with a mistyped session id', { ...eventRecord, sessionId: 42 }],
    ['an event without payload keys', without(eventRecord, 'payloadKeys')],
    ['an event with a mistyped project', { ...eventRecord, project: ['x'] }],
    [
      'an event whose usage lacks a token count',
      { ...dshEventRecord, usage: without(dshEventRecord.usage, 'inputTokens') }
    ],
    [
      'an event whose usage has a negative count',
      { ...dshEventRecord, usage: { ...dshEventRecord.usage, outputTokens: -1 } }
    ],
    ['an event with a mistyped scanEnv variable', { ...eventRecord, scanEnv: { CLAUDE_CONFIG_DIR: 1 } }],
    ['a skip with an empty code', { ...skipRecord, code: '' }],
    ['a skip naming no source or agent', without(skipRecord, 'agent')],
    ['a skip without its native event', without(skipRecord, 'nativeEvent')],
    ['an error without a message', without(errorRecord, 'message')],
    ['an error with an empty code', { ...errorRecord, code: '' }],
    ['a record without an id', without(errorRecord, 'id')],
    ['a record with a mistyped recorded time', { ...errorRecord, recordedAt: '1760000000000' }],
    ['a record with a negative epoch', { ...errorRecord, epoch: -1 }]
  ])('rejects %s', (_name, raw) => {
    expect(parseQueueRecord(raw).ok).toBe(false);
  });

  it('names the failing fields without their values', () => {
    const parsed = parseQueueRecord({ ...eventRecord, sessionId: 'secret-session', project: 1234567 });
    expect(parsed.ok).toBe(false);
    const reason = parsed.ok ? '' : parsed.reason;
    expect(reason).toContain('project');
    expect(reason).not.toContain('1234567');
  });
});

describe('parseQueueApplied', () => {
  it('loads the ids of applied records and drops items that are not ids', () => {
    expect(parseQueueApplied(['a', 'b'])).toEqual(['a', 'b']);
    expect(parseQueueApplied(['a', 1, '', null, 'b'])).toEqual(['a', 'b']);
    expect(parseQueueApplied([])).toEqual([]);
  });

  it.each([[undefined], ['a'], [{ a: true }], [7]])('loads %j as absent', (raw) => {
    expect(parseQueueApplied(raw)).toBeUndefined();
  });
});

describe('parseQueueOwed', () => {
  // Written as a later release would write it: a kind of owed work, entry fields, and fields inside an entry's
  // `usage` and `scanEnv` that this release does not know.
  const later = {
    dshUsage: [
      {
        id: 'r1',
        usage: { ...dshEventRecord.usage, costUsd: 0.25, tier: { name: 'priority' } },
        attempts: 2
      }
    ],
    usageRefresh: [
      {
        source: 'claude',
        scanEnv: { CLAUDE_CONFIG_DIR: '/fake-home/.claude', LATER_HOME: '/fake-home/later' },
        boundaryAt: 1_760_000_000_000,
        generation: 3,
        reason: 'boundary'
      },
      { source: 'later-agent', scanEnv: {}, boundaryAt: 1_760_000_000_500, generation: 1 }
    ],
    renderedSync: true,
    laterKind: [{ anything: { nested: [1, 'two'] } }]
  };

  it('loads keys, entry fields and nested fields it does not know as they are', () => {
    expect(parseQueueOwed(later)).toEqual(later);
  });

  it('types the entries it knows', () => {
    const owed: QueueOwed | undefined = parseQueueOwed(later);
    expect(owed?.dshUsage?.[0]?.usage.model).toBe('deepseek-v4-pro');
    expect(owed?.usageRefresh?.[0]?.scanEnv.CLAUDE_CONFIG_DIR).toBe('/fake-home/.claude');
    expect(owed?.usageRefresh?.[1]?.source).toBe('later-agent');
  });

  it.each([[undefined], [null], ['owed'], [[later]], [3]])('loads %j as absent', (raw) => {
    expect(parseQueueOwed(raw)).toBeUndefined();
  });

  it('loads a known key whose value does not parse as absent and keeps the rest', () => {
    expect(parseQueueOwed({ ...later, dshUsage: 'broken', renderedSync: 'yes' })).toEqual({
      usageRefresh: later.usageRefresh,
      laterKind: later.laterKind
    });
  });

  it('drops only the list entries that do not parse', () => {
    const owed = parseQueueOwed({
      ...later,
      dshUsage: [...later.dshUsage, { id: 'r2' }, { id: 'r3', usage: { ...dshEventRecord.usage, inputTokens: 'x' } }],
      usageRefresh: [{ source: 'codex', scanEnv: {}, boundaryAt: 1, generation: -1 }, ...later.usageRefresh]
    });
    expect(owed?.dshUsage).toEqual(later.dshUsage);
    expect(owed?.usageRefresh).toEqual(later.usageRefresh);
  });
});
