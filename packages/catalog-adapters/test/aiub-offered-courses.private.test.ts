import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ParsedCatalog, parseAiubOfferedCourses } from '../src/index.js';

const path = new URL('./fixtures/private/aiub-offered-courses.xlsx', import.meta.url);

describe.skipIf(!existsSync(path))('private AIUB offered-course report', () => {
  it('matches the report totals and parses in under two seconds', async () => {
    const file = readFileSync(path);
    const start = performance.now();
    const result = await parseAiubOfferedCourses(file);
    expect(performance.now() - start).toBeLessThan(2000);
    const parsed = ParsedCatalog.parse(result);
    expect(parsed.termName).toBe('Fall 2026-2027');
    expect(parsed.stats).toEqual({
      sections: 2921,
      meetings: 4404,
      cancelled: 118,
      skipped: 1,
      errors: 1,
    });
    expect(parsed.problems).toHaveLength(1);
    expect(new Set(parsed.sections.map((section) => section.courseCode)).size).toBe(626);
    expect(new Set(parsed.sections.map((section) => section.externalClassId)).size).toBe(2921);
    expect(
      parsed.sections.every((section) =>
        section.meetings.every((meeting) => meeting.endTime > meeting.startTime),
      ),
    ).toBe(true);
  });
});
