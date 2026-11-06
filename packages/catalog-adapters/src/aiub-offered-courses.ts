import readExcelFile, { type Row, type Sheet } from 'read-excel-file/node';
import type { ParsedCatalog, ParsedMeeting, ParsedSection } from './parsed-catalog.js';

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

const termPattern = /^Offered Course\s+(\d{4}-\d{4}),\s*([a-z]+)$/i;
const statuses = new Map<string, ParsedSection['status']>([
  ['open', 'open'],
  ['freshman', 'freshman'],
  ['reserved', 'reserved'],
  ['closed', 'closed'],
  ['cancel', 'cancelled'],
]);
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const meetingFields = ['Type', 'Day', 'Start Time', 'End Time', 'Room'] as const;
const sharedFields = {
  courseCode: 'Course Code',
  title: 'Course Title',
  sectionLabel: 'Section',
  status: 'Status',
  capacity: 'Capacity',
  enrolled: 'Count',
} as const;

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function isBlank(value: unknown): boolean {
  return value == null || (typeof value === 'string' && value.trim() === '');
}

function count(value: unknown): number | null {
  const input = text(value);
  if (!/^\d+$/.test(input)) return null;
  const parsed = Number(input);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function normalizeTitle(value: unknown, label: string): string {
  const title = text(value).replace(/\s+/g, ' ');
  const bracket = title.lastIndexOf('[');
  const suffix = title
    .slice(bracket + 1)
    .replace(/\]$/, '')
    .trim();
  return bracket >= 0 && suffix === label.replace(/\s+/g, ' ')
    ? title.slice(0, bracket).trimEnd()
    : title;
}

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

function locateHeader(sheet: Sheet) {
  for (const [index, row] of sheet.data.slice(0, 10).entries()) {
    const names = row.map((cell) => text(cell).toLowerCase());
    const columns = new Map(headers.map((field) => [field, names.indexOf(field.toLowerCase())]));
    if ([...columns.values()].every((column) => column >= 0)) return { index, columns };
  }
  return null;
}

function readSection(id: string, cell: ReadCell, report: ReportProblem): SectionDetails | null {
  const courseCode = text(cell('Course Code')).replace(/\s+/g, '').toUpperCase();
  const sectionLabel = text(cell('Section'));
  const title = normalizeTitle(cell('Course Title'), sectionLabel);
  const status = statuses.get(text(cell('Status')).toLowerCase());
  const capacity = count(cell('Capacity'));
  const enrolled = count(cell('Count'));
  if (!courseCode) report('Course Code', 'Course code is required');
  if (!sectionLabel) report('Section', 'Section label is required');
  if (!title) report('Course Title', 'Course title is required');
  if (!status) report('Status', 'Unknown section status');
  if (capacity === null) report('Capacity', 'Expected a nonnegative integer');
  if (enrolled === null) report('Count', 'Expected a nonnegative integer');
  if (!courseCode || !sectionLabel || !title || !status || capacity === null || enrolled === null) {
    return null;
  }
  const faculty = text(cell('Faculty'));
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
  if (weekday < 0) report('Day', 'Unknown meeting day');
  if (!startTime) report('Start Time', 'Invalid meeting start time');
  if (!endTime) report('End Time', 'Invalid meeting end time');
  if (weekday < 0 || !startTime || !endTime) return null;
  if (endTime <= startTime) {
    report('End Time', 'End time must be after start time');
    return null;
  }
  const type = text(cell('Type')).toLowerCase();
  const room = text(cell('Room'));
  return {
    kind: type === 'theory' || type === 'lab' ? type : 'other',
    weekday,
    startTime,
    endTime,
    room: room && room.toUpperCase() !== 'TBA' ? room : null,
  };
}

export async function parseAiubOfferedCourses(file: Uint8Array): Promise<ParsedCatalog> {
  const sheets = await readExcelFile(Buffer.from(file));
  const reportSheet = sheets.find((sheet) => termPattern.test(sheet.sheet.trim()));
  const sheet = reportSheet ?? sheets.find((candidate) => locateHeader(candidate)) ?? sheets[0];
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
    return {
      termName,
      sections: [],
      problems,
      stats: { sections: 0, meetings: 0, cancelled: 0, skipped: 0, errors },
    };
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
        ? (Object.keys(sharedFields) as (keyof typeof sharedFields)[]).find(
            (field) => details[field] !== existing[field],
          )
        : undefined;
    if (!details || conflict) {
      if (conflict) rowProblem(sharedFields[conflict], 'Rows for this class disagree');
      rejectedIds.add(id);
      sectionsById.delete(id);
      continue;
    }

    const section = existing ?? { ...details, meetings: [] };
    // Keep the section if an individual meeting is invalid, preserving any valid meetings.
    const meeting = readMeeting(cell, rowProblem);
    if (meeting) section.meetings.push(meeting);
    sectionsById.set(id, section);
  }

  const sections = [...sectionsById.values()];
  return {
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
  };
}
