import { describe, expect, it } from 'vitest';
import writeExcelFile, { type Cell, type SheetData } from 'write-excel-file/node';
import { ParsedCatalog, parseAiubOfferedCourses, type ParsedSection } from '../src/index.js';

const columns = [
  'Status',
  'Class ID',
  'Course Title',
  'Course Code',
  'Capacity',
  'Count',
  'Section',
  'Faculty',
  'Type',
  'Day',
  'Start Time',
  'End Time',
  'Room',
] as const;

type Cells = Partial<Record<(typeof columns)[number], Cell>>;

function row(id: string | number, overrides: Cells = {}): Cell[] {
  const cells: Cells = {
    'Class ID': id,
    'Course Code': 'CSC1301',
    'Course Title': 'CHEMISTRY [A]',
    Status: 'Open',
    Capacity: '50',
    Count: '53',
    Section: 'A',
    Faculty: '-',
    ...overrides,
  };
  return [null, ...columns.map((column) => cells[column] ?? null)];
}

const reportName = 'Offered Course  2026-2027, Fall';
function workbook(rows: SheetData, sheet = reportName) {
  return writeExcelFile([[null], [null, ...columns], ...rows], { sheet }).toBuffer();
}

function section(id: string, fields: Partial<ParsedSection> = {}): ParsedSection {
  return {
    externalClassId: id,
    courseCode: 'CSC1301',
    title: 'CHEMISTRY',
    sectionLabel: 'A',
    status: 'open',
    capacity: 50,
    enrolled: 53,
    instructorName: null,
    meetings: [],
    ...fields,
  };
}

describe('parseAiubOfferedCourses', () => {
  it('normalizes a synthetic report with moved columns and groups meeting rows', async () => {
    const rows: SheetData = [
      row('00369', {
        'Course Code': ' csc 1301 ',
        Type: 'Theory',
        Day: 'Monday',
        'Start Time': '8:00 AM',
        'End Time': '9:20 AM',
        Room: 6202,
      }),
      row('00369', {
        Type: 'Lab',
        Day: 'Wednesday',
        'Start Time': '12:40 PM',
        'End Time': '2:40 PM',
        Room: 'DE0401',
      }),
      row('00369', {
        Type: 'Workshop',
        Day: 'Thursday',
        'Start Time': '12:10 AM',
        'End Time': '1:00 AM',
        Room: 'TBA',
      }),
      row('00369', {
        Type: 'Lab',
        Day: 'Friday',
        'Start Time': '2:40 PM',
        'End Time': '4:00 PM',
        Room: 'IPE LAB',
      }),
      row('00400', {
        Status: 'Reserved',
        'Course Code': 'MGT2001',
        'Course Title': ' SUPPLY  CHAIN MANAGEMENT [MBA] [A] ',
        Faculty: 'Example Instructor',
        Capacity: 20,
        Count: 7,
      }),
      row(401, {
        Status: 'Freshman',
        'Course Code': 'CSC4001',
        Section: 'Group 20',
        'Course Title': 'CAPSTONE PROJECT [Group 20',
      }),
      row('00402', {
        Status: 'Closed',
        Section: 'L1-A',
        'Course Title': 'CHEMISTRY [L1-A]',
        Type: 'Theory',
        Day: 'Sunday',
        'Start Time': '12:00 PM',
        'End Time': '1:00 PM',
        Room: 'STUDIO',
      }),
      row('00403', { Status: 'Cancel' }),
      row('00404', { 'Course Code': ' ' }),
      row('00405', { Status: 'Invented' }),
      row('00406'),
      row('00406', { Count: 54 }),
      row('00407', { 'Course Title': 'CHEMISTRY [MBA]' }),
      row('00408', {
        Type: 'Lab',
        Day: 'Saturday',
        'Start Time': 0.5,
        'End Time': 0.625,
      }),
      row('00409', {
        Type: 'Theory',
        Day: 'Tuesday',
        'Start Time': '8:00 AM',
        'End Time': '9:00 AM',
      }),
    ];
    const file = await workbook(rows);
    const parsed = ParsedCatalog.parse(await parseAiubOfferedCourses(new Uint8Array(file)));
    expect(parsed).toEqual({
      termName: 'Fall 2026-2027',
      sections: [
        section('00369', {
          meetings: [
            { kind: 'theory', weekday: 1, startTime: '08:00', endTime: '09:20', room: '6202' },
            { kind: 'lab', weekday: 3, startTime: '12:40', endTime: '14:40', room: 'DE0401' },
            { kind: 'other', weekday: 4, startTime: '00:10', endTime: '01:00', room: null },
            { kind: 'lab', weekday: 5, startTime: '14:40', endTime: '16:00', room: 'IPE LAB' },
          ],
        }),
        section('00400', {
          courseCode: 'MGT2001',
          title: 'SUPPLY CHAIN MANAGEMENT [MBA]',
          status: 'reserved',
          capacity: 20,
          enrolled: 7,
          instructorName: 'Example Instructor',
        }),
        section('401', {
          courseCode: 'CSC4001',
          title: 'CAPSTONE PROJECT',
          sectionLabel: 'Group 20',
          status: 'freshman',
        }),
        section('00402', {
          status: 'closed',
          sectionLabel: 'L1-A',
          meetings: [
            { kind: 'theory', weekday: 0, startTime: '12:00', endTime: '13:00', room: 'STUDIO' },
          ],
        }),
        section('00403', { status: 'cancelled' }),
        section('00407', { title: 'CHEMISTRY [MBA]' }),
        section('00408', {
          meetings: [{ kind: 'lab', weekday: 6, startTime: '12:00', endTime: '15:00', room: null }],
        }),
        section('00409', {
          meetings: [
            { kind: 'theory', weekday: 2, startTime: '08:00', endTime: '09:00', room: null },
          ],
        }),
      ],
      problems: [
        { row: 11, field: 'Course Code', message: 'Course code is required' },
        { row: 12, field: 'Status', message: 'Unknown section status' },
        { row: 14, field: 'Count', message: 'Rows for this class disagree' },
      ],
      stats: { sections: 8, meetings: 7, cancelled: 1, skipped: 3, errors: 3 },
    });
    expect(await parseAiubOfferedCourses(file)).toEqual(parsed);
  });

  it('reports missing headers without inventing sections', async () => {
    const file = await writeExcelFile([['Class ID', 'Course Code']], {
      sheet: reportName,
    }).toBuffer();
    expect(ParsedCatalog.parse(await parseAiubOfferedCourses(file))).toEqual({
      termName: 'Fall 2026-2027',
      sections: [],
      problems: [
        {
          row: 0,
          field: 'Header',
          message: 'Required headers were not found in the first ten rows',
        },
      ],
      stats: { sections: 0, meetings: 0, cancelled: 0, skipped: 0, errors: 1 },
    });
  });

  it('keeps good rows when the term cannot be read', async () => {
    const parsed = ParsedCatalog.parse(
      await parseAiubOfferedCourses(await workbook([row('00001')], 'Report')),
    );
    expect(parsed.termName).toBeNull();
    expect(parsed.sections).toEqual([section('00001')]);
    expect(parsed.problems).toEqual([
      { row: 0, field: 'Term', message: 'Could not read term from the sheet name' },
    ]);
  });

  it('reports malformed meeting times at their Excel row and keeps valid meetings', async () => {
    const parsed = ParsedCatalog.parse(
      await parseAiubOfferedCourses(
        await workbook([
          row('00001', {
            Type: 'Lab',
            Day: 'Monday',
            'Start Time': '2:40 PM',
            'End Time': '8:00 AM',
          }),
          [null],
          row('00001', {
            Type: 'Theory',
            Day: 'Thursday',
            'Start Time': '8:00 AM',
            'End Time': '9:00 AM',
          }),
        ]),
      ),
    );
    expect(parsed.problems).toEqual([
      { row: 3, field: 'End Time', message: 'End time must be after start time' },
    ]);
    expect(parsed.sections).toEqual([
      section('00001', {
        meetings: [
          { kind: 'theory', weekday: 4, startTime: '08:00', endTime: '09:00', room: null },
        ],
      }),
    ]);
  });

  it('caps saved problems while counting every invalid class', async () => {
    const rows = Array.from({ length: 205 }, (_, index) => row(index + 1, { Status: 'Unknown' }));
    const parsed = ParsedCatalog.parse(await parseAiubOfferedCourses(await workbook(rows)));
    expect(parsed.problems).toHaveLength(200);
    expect(parsed.problems[199]?.row).toBe(202);
    expect(parsed.stats).toEqual({
      sections: 0,
      meetings: 0,
      cancelled: 0,
      skipped: 205,
      errors: 205,
    });
  });

  it('rejects bytes that are not an XLSX workbook', async () => {
    await expect(
      parseAiubOfferedCourses(new TextEncoder().encode('not a workbook')),
    ).rejects.toThrow();
  });
});
