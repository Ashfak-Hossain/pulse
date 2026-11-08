import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  sectionCursorSchema,
  termListSchema,
  type SectionList,
  type SectionMeeting,
  type SectionQuery,
  type TermList,
} from '@pulse/contracts';
import {
  and,
  asc,
  campus,
  course,
  desc,
  eq,
  ilike,
  inArray,
  or,
  section,
  sectionMeeting,
  sql,
  term,
  withCampus,
  type Database,
} from '@pulse/db';
import { DATABASE } from '../db/db.module.js';

const visibleTerm = inArray(term.status, ['active', 'archived']);

@Injectable()
export class CatalogService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  private async campusId(slug: string): Promise<string> {
    const [tenant] = await this.db
      .select({ id: campus.id })
      .from(campus)
      .where(eq(campus.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Campus not found');
    return tenant.id;
  }

  async terms(slug: string): Promise<TermList> {
    const campusId = await this.campusId(slug);
    const items = await withCampus(this.db, campusId, (tx) =>
      tx
        .select({
          id: term.id,
          name: term.name,
          startsOn: term.startsOn,
          endsOn: term.endsOn,
          status: term.status,
        })
        .from(term)
        .where(visibleTerm)
        .orderBy(desc(term.startsOn), asc(term.id))
        .limit(50),
    );
    return termListSchema.parse({ items });
  }

  async sections(slug: string, query: SectionQuery): Promise<SectionList> {
    const cursor = query.cursor ? decodeCursor(query.cursor) : null;
    const campusId = await this.campusId(slug);
    const pattern =
      query.q === undefined ? undefined : '%' + query.q.replace(/[\\%_]/g, '\\$&') + '%';

    // Keep the page and its meeting rows on the same snapshot during catalog imports.
    return withCampus(
      this.db,
      campusId,
      async (tx) => {
        const [found] = await tx
          .select({ id: term.id })
          .from(term)
          .where(and(eq(term.id, query.termId), visibleTerm))
          .limit(1);
        if (!found) throw new NotFoundException('Term not found');

        const rows = await tx
          .select({
            id: section.id,
            termId: section.termId,
            course: { code: course.code, title: course.title },
            title: section.title,
            sectionLabel: section.sectionLabel,
            status: section.status,
            capacity: section.capacity,
            enrolled: section.enrolled,
            instructorName: section.instructorName,
          })
          .from(section)
          .innerJoin(
            course,
            and(eq(course.id, section.courseId), eq(course.campusId, section.campusId)),
          )
          .where(
            and(
              eq(section.termId, found.id),
              pattern === undefined
                ? undefined
                : or(
                    ilike(course.code, pattern),
                    ilike(course.title, pattern),
                    ilike(section.title, pattern),
                  ),
              cursor
                ? sql`(${course.code}, ${section.sectionLabel}, ${section.id})
            > (${cursor.code}, ${cursor.sectionLabel}, ${cursor.id})`
                : undefined,
            ),
          )
          .orderBy(asc(course.code), asc(section.sectionLabel), asc(section.id))
          .limit(query.limit + 1);
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        if (!last) return { items: [], nextCursor: null };

        const meetingRows = await tx
          .select({
            sectionId: sectionMeeting.sectionId,
            kind: sectionMeeting.kind,
            weekday: sectionMeeting.weekday,
            startTime: sectionMeeting.startTime,
            endTime: sectionMeeting.endTime,
            room: sectionMeeting.room,
          })
          .from(sectionMeeting)
          .where(
            inArray(
              sectionMeeting.sectionId,
              page.map(({ id }) => id),
            ),
          )
          .orderBy(
            asc(sectionMeeting.weekday),
            asc(sectionMeeting.startTime),
            asc(sectionMeeting.id),
          );
        const meetings = new Map<string, SectionMeeting[]>();
        for (const { sectionId, ...row } of meetingRows) {
          const meeting = {
            ...row,
            startTime: minuteTime(row.startTime),
            endTime: minuteTime(row.endTime),
          };
          const list = meetings.get(sectionId);
          if (list) list.push(meeting);
          else meetings.set(sectionId, [meeting]);
        }

        return {
          items: page.map((row) => ({ ...row, meetings: meetings.get(row.id) ?? [] })),
          nextCursor: rows.length > query.limit ? encodeCursor(last) : null,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}

function encodeCursor(last: { course: { code: string }; sectionLabel: string; id: string }) {
  const position = { code: last.course.code, sectionLabel: last.sectionLabel, id: last.id };
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

function decodeCursor(token: string) {
  const bytes = Buffer.from(token, 'base64url');
  if (bytes.toString('base64url') !== token) throw new BadRequestException('Invalid cursor');
  try {
    const input: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return sectionCursorSchema.parse(input);
  } catch {
    throw new BadRequestException('Invalid cursor');
  }
}

function minuteTime(value: string): string {
  return value.replace(/^(\d{2}:\d{2}):00$/, '$1');
}
