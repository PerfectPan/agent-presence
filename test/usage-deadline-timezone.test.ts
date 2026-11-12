import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vite-plus/test';

// TZ is process-global: separate processes exercise actual timezone rules without changing parallel tests' clocks.
const timeUrl = new URL('../src/time.ts', import.meta.url).href;
describe('usage deadline at local midnight across DST', () => {
  it.each([
    ['America/New_York', 2026, 2, 8, 1, 23],
    ['America/New_York', 2026, 10, 1, 1, 25],
    ['America/New_York', 2026, 2, 7, 7, 167],
    ['America/New_York', 2026, 9, 31, 7, 169],
    ['Australia/Lord_Howe', 2026, 9, 4, 1, 23.5]
  ] as const)('%s %i/%i/%i +%i days', (tz, year, month, day, days, hours) => {
    const output = execFileSync(
      process.execPath,
      [
        ...(process.allowedNodeEnvironmentFlags.has('--experimental-transform-types')
          ? ['--experimental-transform-types']
          : []),
        '--input-type=module',
        '-e',
        `
      import { badgeExpiryMs, calendarDaysBetween, startOfLocalDayMs } from ${JSON.stringify(timeUrl)};
      const computed = new Date(${year}, ${month}, ${day}, 0, 10).getTime();
      const deadline = badgeExpiryMs(computed, ${days});
      process.stdout.write(JSON.stringify({
        deadline, expected: new Date(${year}, ${month}, ${day + days}).getTime(),
        before: calendarDaysBetween(computed, deadline - 1), at: calendarDaysBetween(computed, deadline),
        hours: (deadline - startOfLocalDayMs(computed)) / 3600000
      }));
    `
      ],
      { env: { ...process.env, TZ: tz }, encoding: 'utf8' }
    );
    const value = JSON.parse(output) as {
      deadline: number;
      expected: number;
      before: number;
      at: number;
      hours: number;
    };
    expect(value.deadline).toBe(value.expected);
    expect(value.before).toBe(days - 1);
    expect(value.at).toBe(days);
    expect(value.hours).toBe(hours);
  });
});
