import { describe, expect, it } from 'vite-plus/test';
import { createBacklogWarning, BACKLOG_WARNING_RECORDS } from './apply.js';

describe('createBacklogWarning', () => {
  it('warns once per run, and again only after the backlog fell below the threshold', () => {
    const warning = createBacklogWarning();
    const above = BACKLOG_WARNING_RECORDS + 1;
    const below = BACKLOG_WARNING_RECORDS;

    expect(warning.due(below)).toBe(false);
    expect(warning.due(above)).toBe(true);
    expect(warning.due(above)).toBe(false);

    expect(warning.due(below)).toBe(false);
    expect(warning.due(above)).toBe(true);
  });
});
