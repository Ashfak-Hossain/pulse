import { catalogLimits } from '@pulse/contracts';
import { strFromU8, unzipSync, zipSync } from 'fflate';
import readExcelFile, { type Row, type Sheet } from 'read-excel-file/node';
import { Parser } from 'saxen';
import {
  maxSectionCount,
  parsedCatalogSchema,
  type ParsedCatalog,
  type ParsedMeeting,
  type ParsedSection,
} from './parsed-catalog.js';

const headers = [
  'Class ID',
  'Course Code',
  'Status',
  'Capacity',
  'Count',
  'Course Title',
  'Section',
  'Faculty',
  'Type',
  'Day',
  'Start Time',
  'End Time',
  'Room',
] as const;
type Header = (typeof headers)[number];
type ReadCell = (field: Header) => Row[number] | undefined;
type ReportProblem = (field: string, message: string) => void;
type SectionDetails = Omit<ParsedSection, 'meetings'>;

// AIUB's real report is about 1 MB and 4,500 rows. These limits sit far above it and far below
// what would exhaust memory: an XLSX is a ZIP, and a few KB can claim to unpack to gigabytes
const maxFileBytes = 5 * 1024 * 1024;
const maxEntryBytes = 32 * 1024 * 1024;
const maxUnzippedBytes = 64 * 1024 * 1024;
const maxEntries = 200;
const maxRows = 20_000;
const maxColumns = 64;
const tooManyCells = `The sheet has more than ${maxRows} rows or ${maxColumns} columns`;

const termPattern = /^Offered Course\s+(\d{4}-\d{4}),\s*([a-z]{1,20})$/i;
const statuses = new Map<string, ParsedSection['status']>([
  ['open', 'open'],
  ['freshman', 'freshman'],
  ['reserved', 'reserved'],
  ['closed', 'closed'],
  ['cancel', 'cancelled'],
]);
const sectionCountMessage = `Expected an integer from 0 to ${maxSectionCount}`;
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const meetingFields = ['Type', 'Day', 'Start Time', 'End Time', 'Room'] as const;
// Every row of one class repeats these. Rows that disagree reject the class: we cannot tell
// which row is right
const sectionFields = {
  courseCode: 'Course Code',
  title: 'Course Title',
  sectionLabel: 'Section',
  status: 'Status',
  capacity: 'Capacity',
  enrolled: 'Count',
} as const;
// Control and bidi characters can make one name look like another in admin screens. Not all of
// \p{Cf}: Bangla needs the zero-width joiners (U+200C, U+200D)
const hiddenCharacters = /[\p{Cc}\u061C\u200B\u200E\u200F\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/u;

/**
 * Parses AIUB's offered-course XLSX into one term's sections and meetings. Bad rows become
 * `problems` (fixed text, never cell values); a file that is too big or not a workbook throws.
 * Untrusted uploads still belong in a worker with its own memory and time limits.
 */
export async function parseAiubOfferedCourses(file: Uint8Array): Promise<ParsedCatalog> {
  const sheets = await readWorkbook(file);
  const reportSheet = sheets.find((sheet) => termPattern.test(sheet.sheet.trim()));
  const sheet = reportSheet ?? sheets.find((candidate) => locateHeader(candidate)) ?? sheets[0];
  if (sheet && sheet.data.length > maxRows) throw new Error(tooManyCells);
  const term = termPattern.exec(sheet?.sheet.trim() ?? '');
  const termName = term ? term[2] + ' ' + term[1] : null;
  const problems: ParsedCatalog['problems'] = [];
  let errors = 0;
  const report = (row: number, field: string, message: string) => {
    errors++;
    // Diagnostic messages are fixed text. Keep workbook values out of logs and import errors.
    if (problems.length < 200) problems.push({ row, field, message });
  };

  if (!termName) report(0, 'Term', 'Could not read term from the sheet name');
  const header = sheet && locateHeader(sheet);
  if (!header) {
    report(0, 'Header', 'Required headers were not found in the first ten rows');
    return parsedCatalogSchema.parse({
      termName,
      sections: [],
      problems,
      stats: { sections: 0, meetings: 0, cancelled: 0, skipped: 0, errors },
    });
  }

  const sectionsById = new Map<string, ParsedSection>();
  const rejectedIds = new Set<string>();
  let unidentifiedRows = 0;
  for (const [index, row] of sheet.data.entries()) {
    if (index <= header.index) continue;
    const cell: ReadCell = (field) => row[header.columns.get(field) ?? -1];
    if (headers.every((field) => isBlank(cell(field)))) continue;
    const rowProblem: ReportProblem = (field, message) => report(index + 1, field, message);
    const id = text(cell('Class ID'));
    if (!id) {
      rowProblem('Class ID', 'Class ID is required');
      unidentifiedRows++;
      continue;
    }
    if (rejectedIds.has(id)) continue;

    const details = readSection(id, cell, rowProblem);
    const existing = sectionsById.get(id);
    const conflict =
      details && existing
        ? (Object.keys(sectionFields) as (keyof typeof sectionFields)[]).find(
            (field) => details[field] !== existing[field],
          )
        : undefined;
    if (!details || conflict) {
      if (conflict) rowProblem(sectionFields[conflict], 'Rows for this class disagree');
      rejectedIds.add(id);
      sectionsById.delete(id);
      continue;
    }

    const section = existing ?? { ...details, meetings: [] };
    // Keep the section if an individual meeting is invalid, preserving any valid meetings.
    const meeting = readMeeting(cell, rowProblem);
    if (meeting && section.meetings.some((other) => sameSlot(other, meeting))) {
      // section_meeting allows one meeting of a kind per start time; the importer would fail
      rowProblem('Start Time', 'Repeats another meeting of this class at this time');
    } else if (meeting && section.meetings.length >= catalogLimits.meetingsPerSection) {
      rowProblem('Day', `More than ${catalogLimits.meetingsPerSection} meetings for this class`);
    } else if (meeting) {
      section.meetings.push(meeting);
    }
    sectionsById.set(id, section);
  }

  const sections = [...sectionsById.values()];
  return parsedCatalogSchema.parse({
    termName,
    sections,
    problems,
    stats: {
      sections: sections.length,
      meetings: sections.reduce((sum, section) => sum + section.meetings.length, 0),
      cancelled: sections.filter((section) => section.status === 'cancelled').length,
      skipped: rejectedIds.size + unidentifiedRows,
      errors,
    },
  });
}

/**
 * Always unpacks with fflate first, checking the ZIP directory before anything is inflated: a
 * deflated entry gets exactly its declared size and a stored one is copied by its compressed
 * size, so counting the larger of the two bounds memory even when the sizes lie or many entries
 * point at one payload. Repacking uncompressed also fixes AIUB exports whose local headers
 * confuse the streaming XLSX reader.
 */
async function readWorkbook(file: Uint8Array): Promise<Sheet[]> {
  if (file.byteLength > maxFileBytes) throw new Error('The workbook is larger than 5 MB');
  let count = 0;
  let unzipped = 0;
  let tooBig = false;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(file, {
      filter: ({ name, size, originalSize }) => {
        count++;
        if (!name.endsWith('.xml') && !name.endsWith('.rels')) return false;
        const bytes = Math.max(size, originalSize);
        unzipped += bytes;
        tooBig ||= count > maxEntries || bytes > maxEntryBytes || unzipped > maxUnzippedBytes;
        return !tooBig;
      },
    });
  } catch {
    // Decoder errors may contain private workbook values.
    throw new Error('Could not read the XLSX workbook');
  }
  if (tooBig) throw new Error('The workbook unpacks past the size limit');
  // Every part, not only xl/worksheets/: the reader finds sheets through workbook.xml.rels, so a
  // sheet can sit anywhere. Parts that are not sheets have no rows or cells and pass
  for (const xml of Object.values(entries)) {
    let fits: boolean;
    try {
      fits = fitsGrid(strFromU8(xml));
    } catch {
      // Malformed XML; the parser's message may quote workbook values
      throw new Error('Could not read the XLSX workbook');
    }
    if (!fits) throw new Error(tooManyCells);
  }
  try {
    return await readExcelFile(Buffer.from(zipSync(entries, { level: 0 })));
  } catch {
    throw new Error('Could not read the XLSX workbook');
  }
}

/**
 * Whether the rows and columns read-excel-file would build for this sheet stay within the limits.
 * It fills every gap below the highest address, so one cell at A2000000 in a 1 KB file would build
 * two million rows. Worked out the way it reads the XML (the same saxen parser, prefixes dropped,
 * entities decoded, a row without `r` numbered after the last), stopping at the first breach.
 */
function fitsGrid(xml: string): boolean {
  let rows = 0;
  let rowNumber: number | undefined;
  let fits = true;
  const parser = new Parser();
  const refuse = () => {
    fits = false;
    parser.stop();
  };
  parser.on('openTag', (name, getAttributes, decodeEntities) => {
    const tag = localName(name);
    if (tag !== 'row' && tag !== 'c') return;
    // Two spellings of r (r and x:r) resolve in an order that is hard to copy exactly; real
    // workbooks never have both, so refuse
    const rs = Object.entries(getAttributes()).filter(([key]) => localName(key, true) === 'r');
    if (rs.length > 1) return refuse();
    const r = rs[0] && decodeEntities(rs[0][1]);
    if (tag === 'row') {
      rowNumber = r ? Number(r) || undefined : undefined;
      if (rowNumber !== undefined && rowNumber > maxRows) refuse();
      return;
    }
    const address = r === undefined ? undefined : cellAddress(r);
    if (!address || address[0] > maxRows || address[1] > maxColumns) return refuse();
    rowNumber ??= address[0];
  });
  parser.on('closeTag', (name) => {
    if (localName(name) !== 'row') return;
    rows = Math.max(rows + 1, rowNumber ?? 0);
    rowNumber = undefined;
    if (rows > maxRows) refuse();
  });
  parser.parse(xml);
  return fits;
}

// read-excel-file's trimXmlnsPrefix: the part after the first colon, where an attribute skips the
// colon of a leading "xmlns:" (so xmlns:x:r is r)
function localName(name: string, isAttribute = false): string {
  for (let i = 0; i < name.length; i++) {
    const xmlnsColon = isAttribute && i === 5 && name.startsWith('xmlns');
    if (name[i] === ':' && !xmlnsColon) return name.slice(i + 1);
  }
  return name;
}

// read-excel-file's parseCellAddress: letters before the first digit count from A = 1, and the
// rest is the row as Number() reads it (so "A2e6" is row 2,000,000)
function cellAddress(address: string): [row: number, column: number] | undefined {
  let column = 0;
  for (let i = 0; i < address.length; i++) {
    const code = address.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      const row = Number(address.slice(i));
      return Number.isNaN(row) ? undefined : [row, column];
    }
    column = column * 26 + code - 64;
  }
  return undefined;
}

function readSection(id: string, cell: ReadCell, report: ReportProblem): SectionDetails | null {
  const courseCode = text(cell('Course Code')).replace(/\s+/g, '').toUpperCase();
  const sectionLabel = text(cell('Section'));
  const title = normalizeTitle(cell('Course Title'), sectionLabel);
  const status = statuses.get(text(cell('Status')).toLowerCase());
  const capacity = count(cell('Capacity'));
  const enrolled = count(cell('Count'));
  const faculty = text(cell('Faculty'));
  if (!courseCode) report('Course Code', 'Course code is required');
  if (!sectionLabel) report('Section', 'Section label is required');
  if (!title) report('Course Title', 'Course title is required');
  if (!status) report('Status', 'Unknown section status');
  if (capacity === null) report('Capacity', sectionCountMessage);
  if (enrolled === null) report('Count', sectionCountMessage);
  // Every check runs, so one row reports all its problems at once
  const safe = [
    isSafeText('Class ID', id, catalogLimits.externalClassId, report),
    isSafeText('Course Code', courseCode, catalogLimits.courseCode, report),
    isSafeText('Section', sectionLabel, catalogLimits.sectionLabel, report),
    isSafeText('Course Title', title, catalogLimits.courseTitle, report),
    isSafeText('Faculty', faculty, catalogLimits.instructorName, report),
  ].every(Boolean);
  if (
    !safe ||
    !courseCode ||
    !sectionLabel ||
    !title ||
    !status ||
    capacity === null ||
    enrolled === null
  ) {
    return null;
  }
  return {
    externalClassId: id,
    courseCode,
    title,
    sectionLabel,
    status,
    capacity,
    enrolled,
    instructorName: faculty && faculty !== '-' ? faculty : null,
  };
}

function readMeeting(cell: ReadCell, report: ReportProblem): ParsedMeeting | null {
  if (meetingFields.every((field) => isBlank(cell(field)))) return null;
  const weekday = weekdays.indexOf(text(cell('Day')).toLowerCase());
  const startTime = time(cell('Start Time'));
  const endTime = time(cell('End Time'));
  const room = text(cell('Room'));
  if (weekday < 0) report('Day', 'Unknown meeting day');
  if (!startTime) report('Start Time', 'Invalid meeting start time');
  if (!endTime) report('End Time', 'Invalid meeting end time');
  const safeRoom = isSafeText('Room', room, catalogLimits.room, report);
  if (weekday < 0 || !startTime || !endTime || !safeRoom) return null;
  if (endTime <= startTime) {
    report('End Time', 'End time must be after start time');
    return null;
  }
  const type = text(cell('Type')).toLowerCase();
  return {
    kind: type === 'theory' || type === 'lab' ? type : 'other',
    weekday,
    startTime,
    endTime,
    room: room && room.toUpperCase() !== 'TBA' ? room : null,
  };
}

function sameSlot(a: ParsedMeeting, b: ParsedMeeting): boolean {
  return a.weekday === b.weekday && a.startTime === b.startTime && a.kind === b.kind;
}

function locateHeader(sheet: Sheet) {
  for (const [index, row] of sheet.data.slice(0, 10).entries()) {
    const names = row.map((cell) => text(cell).toLowerCase());
    const columns = new Map(headers.map((field) => [field, names.indexOf(field.toLowerCase())]));
    if ([...columns.values()].every((column) => column >= 0)) return { index, columns };
  }
  return null;
}

// Runs of whitespace (tabs, line breaks inside a cell) become one space
function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).replace(/\s+/g, ' ').trim()
    : '';
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function isSafeText(field: string, value: string, max: number, report: ReportProblem): boolean {
  if (value.length > max) {
    report(field, `Longer than ${max} characters`);
    return false;
  }
  if (hiddenCharacters.test(value)) {
    report(field, 'Contains hidden characters');
    return false;
  }
  return true;
}

function count(value: unknown): number | null {
  const input = text(value);
  if (!/^\d+$/.test(input)) return null;
  const parsed = Number(input);
  return parsed <= maxSectionCount ? parsed : null;
}

// AIUB appends the section to the title ("CHEMISTRY [A]"); the section has its own column
function normalizeTitle(value: unknown, label: string): string {
  const title = text(value);
  const bracket = title.lastIndexOf('[');
  const suffix = title
    .slice(bracket + 1)
    .replace(/\]$/, '')
    .trim();
  return bracket >= 0 && suffix === label ? title.slice(0, bracket).trimEnd() : title;
}

// A time cell arrives as text ("8:00 AM"), a fraction of a day (0.5 = noon) or, when the cell
// has a time format, a Date on 1899-12-30 in UTC
function time(value: unknown): string | null {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString().slice(11, 16) : null;
  }
  if (typeof value === 'number' && value >= 0 && value < 1) {
    const minutes = Math.round(value * 1440);
    if (minutes >= 1440) return null;
    return formatTime(Math.floor(minutes / 60), minutes % 60);
  }
  const match = /^(\d{1,2}):([0-5]\d)\s*(AM|PM)?$/i.exec(text(value));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  const period = match[3]?.toUpperCase();
  if (!period) return hour < 24 ? formatTime(hour, minute) : null;
  if (hour < 1 || hour > 12) return null;
  return formatTime((hour % 12) + (period === 'PM' ? 12 : 0), minute);
}

function formatTime(hour: number, minute: number): string {
  return String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
}
