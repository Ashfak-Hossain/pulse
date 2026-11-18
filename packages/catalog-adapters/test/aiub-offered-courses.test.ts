import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import writeExcelFile, { type Cell, type SheetData } from 'write-excel-file/node';
import { parsedCatalogSchema, parseAiubOfferedCourses, type ParsedSection } from '../src/index.js';

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

// Recreate the registrar's ZIP layout from generated test data. Streaming ZIP
// writers add descriptors, and the report also populates each local header.
function withPopulatedDescriptorHeaders(file: Uint8Array): Buffer {
  const chunks: Uint8Array[] = [];
  const archive = new Zip((error, chunk) => {
    if (error) throw error;
    chunks.push(chunk);
  });
  for (const [name, data] of Object.entries(unzipSync(file))) {
    const entry = new ZipDeflate(name);
    archive.add(entry);
    entry.push(data, true);
  }
  archive.end();

  const zip = Buffer.concat(chunks);
  const count = zip.readUInt16LE(zip.length - 12);
  let offset = zip.readUInt32LE(zip.length - 6);
  for (let i = 0; i < count; i++) {
    const local = zip.readUInt32LE(offset + 42);
    // Copy the CRC and compressed/uncompressed sizes from the directory.
    zip.copy(zip, local + 14, offset + 16, offset + 28);
    offset +=
      46 +
      zip.readUInt16LE(offset + 28) +
      zip.readUInt16LE(offset + 30) +
      zip.readUInt16LE(offset + 32);
  }
  return zip;
}

// One stored 1 MB payload that `copies` directory entries all point at, each claiming size 0
function repeatedStoredEntry(copies: number): Buffer {
  const payload = Buffer.alloc(1024 * 1024, 0x20);
  const local = Buffer.alloc(35);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt16LE(5, 26);
  local.write('a.xml', 30);
  const directory = Array.from({ length: copies }, (_, i) => {
    const name = `x${i}.xml`;
    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt16LE(name.length, 28);
    entry.write(name, 46);
    return entry;
  });
  const end = Buffer.alloc(22);
  const size = directory.reduce((sum, entry) => sum + entry.length, 0);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(copies, 8);
  end.writeUInt16LE(copies, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(local.length + payload.length, 16);
  return Buffer.concat([local, payload, ...directory, end]);
}

// The generated workbook with its sheet moved to xl/sheet1.xml, which the reader still finds
async function withSheetOutsideWorksheets(extra: string): Promise<Uint8Array> {
  const entries = unzipSync(await withSheetXml(extra));
  const name = Object.keys(entries).find((entry) => entry.startsWith('xl/worksheets/')) ?? '';
  const sheet = entries[name] ?? new Uint8Array();
  const rest = { ...entries };
  delete rest[name];
  const rels = 'xl/_rels/workbook.xml.rels';
  const relsXml = strFromU8(rest[rels] ?? new Uint8Array()).replace(
    name.replace('xl/', ''),
    'sheet1.xml',
  );
  return zipSync({ ...rest, [rels]: strToU8(relsXml), 'xl/sheet1.xml': sheet });
}

// The generated workbook with extra XML at the end of its sheet data
async function withSheetXml(extra: string): Promise<Uint8Array> {
  const entries = unzipSync(await workbook([row('00001')]));
  const name = Object.keys(entries).find((entry) => entry.startsWith('xl/worksheets/')) ?? '';
  const xml = strFromU8(entries[name] ?? new Uint8Array());
  return zipSync({
    ...entries,
    [name]: strToU8(xml.replace('</sheetData>', extra + '</sheetData>')),
  });
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
    const parsed = parsedCatalogSchema.parse(await parseAiubOfferedCourses(new Uint8Array(file)));
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

  it('rejects counts the section table cannot store', async () => {
    const rows = [
      row('00001', { Capacity: '40000' }),
      row('00002', { Count: 32768 }),
      row('00003', { Capacity: '32767', Count: '32767' }),
    ];
    const parsed = await parseAiubOfferedCourses(await workbook(rows));
    expect(parsed.sections.map((section) => section.externalClassId)).toEqual(['00003']);
    expect(parsed.problems).toEqual([
      { row: 3, field: 'Capacity', message: 'Expected an integer from 0 to 32767' },
      { row: 4, field: 'Count', message: 'Expected an integer from 0 to 32767' },
    ]);
    expect(parsed.stats.skipped).toBe(2);
  });

  it('reports missing headers without inventing sections', async () => {
    const file = await writeExcelFile([['Class ID', 'Course Code']], {
      sheet: reportName,
    }).toBuffer();
    expect(parsedCatalogSchema.parse(await parseAiubOfferedCourses(file))).toEqual({
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
    const parsed = parsedCatalogSchema.parse(
      await parseAiubOfferedCourses(await workbook([row('00001')], 'Report')),
    );
    expect(parsed.termName).toBeNull();
    expect(parsed.sections).toEqual([section('00001')]);
    expect(parsed.problems).toEqual([
      { row: 0, field: 'Term', message: 'Could not read term from the sheet name' },
    ]);
  });

  it('reports malformed meeting times at their Excel row and keeps valid meetings', async () => {
    const parsed = parsedCatalogSchema.parse(
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
    const parsed = parsedCatalogSchema.parse(await parseAiubOfferedCourses(await workbook(rows)));
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

  it('reads a ZIP with populated local headers and data descriptors', async () => {
    const file = withPopulatedDescriptorHeaders(await workbook([row('00001')]));
    const parsed = parsedCatalogSchema.parse(await parseAiubOfferedCourses(file));
    expect(parsed.sections).toEqual([section('00001')]);
    expect(parsed.problems).toEqual([]);
  });

  it('reads a start time from a time-formatted cell', async () => {
    const at = (hour: number, minute: number): Cell => ({
      value: new Date(Date.UTC(1899, 11, 30, hour, minute)),
      type: Date,
      format: 'hh:mm',
    });
    const file = await workbook([
      row('00001', {
        Type: 'Theory',
        Day: 'Monday',
        'Start Time': at(8, 0),
        'End Time': at(9, 20),
      }),
    ]);
    const parsed = await parseAiubOfferedCourses(file);
    expect(parsed.sections[0]?.meetings).toEqual([
      { kind: 'theory', weekday: 1, startTime: '08:00', endTime: '09:20', room: null },
    ]);
  });

  it('rejects over-long and disguised text with a fixed message', async () => {
    const rows = [
      row('00001', { 'Course Code': 'C'.repeat(33) }),
      row('00002', { Faculty: 'Dr. \u202Eevil' }),
      row('00003', { Faculty: 'Line\nbreak' }),
      row('00004', {
        Type: 'Lab',
        Day: 'Monday',
        'Start Time': '8:00',
        'End Time': '9:00',
        Room: 'R\u2066',
      }),
    ];
    const parsed = await parseAiubOfferedCourses(await workbook(rows));
    expect(parsed.problems).toEqual([
      { row: 3, field: 'Course Code', message: 'Longer than 32 characters' },
      { row: 4, field: 'Faculty', message: 'Contains hidden characters' },
      { row: 6, field: 'Room', message: 'Contains hidden characters' },
    ]);
    // A line break inside a cell is only whitespace; the class without a valid room keeps its row
    expect(parsed.sections.map((s) => [s.externalClassId, s.instructorName, s.meetings])).toEqual([
      ['00003', 'Line break', []],
      ['00004', null, []],
    ]);
  });

  it('keeps 20 meetings a class and reports a repeated slot or a 21st meeting', async () => {
    const meeting = (day: string, start: string, end: string): Cells => ({
      Type: 'Theory',
      Day: day,
      'Start Time': start,
      'End Time': end,
    });
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday'];
    const hours = ['8', '9', '10', '11'];
    const rows = days.flatMap((day) =>
      hours.map((hour) => row('00001', meeting(day, `${hour}:00`, `${hour}:50`))),
    );
    rows.push(row('00001', meeting('Sunday', '8:00', '8:30')));
    rows.push(row('00001', meeting('Saturday', '8:00', '8:50')));
    const parsed = await parseAiubOfferedCourses(await workbook(rows));
    expect(parsed.sections[0]?.meetings).toHaveLength(20);
    expect(parsed.problems).toEqual([
      {
        row: 23,
        field: 'Start Time',
        message: 'Repeats another meeting of this class at this time',
      },
      { row: 24, field: 'Day', message: 'More than 20 meetings for this class' },
    ]);
  });

  it('refuses a file over 5 MB before unpacking it', async () => {
    await expect(parseAiubOfferedCourses(new Uint8Array(5 * 1024 * 1024 + 1))).rejects.toThrow(
      'The workbook is larger than 5 MB',
    );
  });

  // A zip bomb: a few bytes that claim to unpack to far more. The claim alone is refused
  it('refuses a workbook whose entries claim to unpack past the limit', async () => {
    const zip = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(10) }));
    const directory = zip.readUInt32LE(zip.length - 6);
    zip.writeUInt32LE(40 * 1024 * 1024, directory + 24);
    await expect(parseAiubOfferedCourses(zip)).rejects.toThrow(
      'The workbook unpacks past the size limit',
    );
  });

  it('checks a sheet the workbook keeps outside xl/worksheets', async () => {
    const plain = await withSheetOutsideWorksheets('');
    expect((await parseAiubOfferedCourses(plain)).sections).toEqual([section('00001')]);
    const far = await withSheetOutsideWorksheets(
      '<row r="2000000"><c r="A2000000"><v>1</v></c></row>',
    );
    await expect(parseAiubOfferedCourses(far)).rejects.toThrow(
      'The sheet has more than 20000 rows or 64 columns',
    );
  });

  it.each([
    ['many directory entries sharing one stored payload', repeatedStoredEntry(100)],
    [
      'more than 200 entries',
      zipSync(
        Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`${i}.xml`, new Uint8Array(1)])),
      ),
    ],
  ])('refuses %s', async (_name, file) => {
    await expect(parseAiubOfferedCourses(file)).rejects.toThrow(
      'The workbook unpacks past the size limit',
    );
  });

  it('refuses a sheet with more than 20,000 rows', async () => {
    const rows = Array.from({ length: 20_000 }, () => [{ value: 'x' }]);
    await expect(parseAiubOfferedCourses(await workbook(rows))).rejects.toThrow(
      'The sheet has more than 20000 rows or 64 columns',
    );
  });

  // One far-away cell makes the XLSX reader build every row and column before it. Each spelling
  // below is one the reader understands, so the check must read it the same way
  const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  it.each([
    ['a far row', '<row r="2000000"><c r="A2000000"><v>1</v></c></row>'],
    ['a far column', '<row r="9"><c r="BM9"><v>1</v></c></row>'],
    ['single quotes', "<row r='2000000'><c r='A2000000'><v>1</v></c></row>"],
    ['a character reference', '<row><c r="A&#50;000000"><v>1</v></c></row>'],
    ['a namespace prefix', `<x:row xmlns:x="${main}"><x:c r="A2000000"><v>1</v></x:c></x:row>`],
    ['lowercase letters', '<row r="9"><c r="zz9"><v>1</v></c></row>'],
    ['an exponent', '<row><c r="A2e6"><v>1</v></c></row>'],
    ['rows without numbers', '<row/>'.repeat(20_001)],
    [
      'two spellings of r',
      '<row r="9"><x:c xmlns:x="${main}" x:r="BL2000000" r="A9"><v>1</v></x:c></row>',
    ],
  ])('refuses a sheet that grows past the limits through %s', async (_name, extra) => {
    await expect(parseAiubOfferedCourses(await withSheetXml(extra))).rejects.toThrow(
      'The sheet has more than 20000 rows or 64 columns',
    );
  });

  it('rejects bytes that are not an XLSX workbook', async () => {
    await expect(
      parseAiubOfferedCourses(new TextEncoder().encode('not a workbook')),
    ).rejects.toThrow('Could not read the XLSX workbook');
  });
});
