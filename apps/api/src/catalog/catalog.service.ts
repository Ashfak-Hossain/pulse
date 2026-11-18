import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  sectionCursorSchema,
  sectionListSchema,
  termListSchema,
  type SectionList,
  type SectionMeeting,
  type SectionQuery,
  type TermList,
} from '@pulse/contracts';
import {
  and,
  asc,
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
import { CampusService } from '../campus/campus.service.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { DATABASE } from '../db/db.module.js';

// A draft term is still being imported, so students see only active and past terms
const visibleTerm = inArray(term.status, ['active', 'archived']);

@Injectable()
export class CatalogService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly campuses: CampusService,
  ) {}

  async terms(slug: string): Promise<TermList> {
    const campusId = await this.campuses.idBySlug(slug);
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
        .orderBy(desc(term.startsOn), asc(term.id)),
    );
    return termListSchema.parse({ items });
  }

  async sections(slug: string, query: SectionQuery): Promise<SectionList> {
    const cursor = query.cursor ? decodeCursor(query.cursor, sectionCursorSchema) : null;
    const campusId = await this.campuses.idBySlug(slug);
    // \, % and _ are LIKE wildcards; escaped, a search for "100%" matches that text literally
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
          // The campus in the join keeps the composite foreign key's index in play
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
              // Row comparison: everything after the last row of the previous page, in sort order
              cursor
                ? sql`(${course.code}, ${section.sectionLabel}, ${section.id})
            > (${cursor.code}, ${cursor.sectionLabel}, ${cursor.id})`
                : undefined,
            ),
          )
          .orderBy(asc(course.code), asc(section.sectionLabel), asc(section.id))
          // One extra row says whether another page exists, without a count query
          .limit(query.limit + 1);
        const page = rows.slice(0, query.limit);
        const last = page.at(-1);
        if (!last) return sectionListSchema.parse({ items: [], nextCursor: null });

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
        // One query for the whole page's meetings, grouped here, instead of one query per section
        const meetings = new Map<string, SectionMeeting[]>();
        for (const { sectionId, ...row } of meetingRows) {
          const meeting = {
            ...row,
            startTime: dropZeroSeconds(row.startTime),
            endTime: dropZeroSeconds(row.endTime),
          };
          const list = meetings.get(sectionId);
          if (list) list.push(meeting);
          else meetings.set(sectionId, [meeting]);
        }

        return sectionListSchema.parse({
          items: page.map((row) => ({ ...row, meetings: meetings.get(row.id) ?? [] })),
          nextCursor:
            rows.length > query.limit
              ? encodeCursor({
                  code: last.course.code,
                  sectionLabel: last.sectionLabel,
                  id: last.id,
                })
              : null,
        });
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}

// PostgreSQL prints time as 14:00:00; the app shows 14:00. Real seconds (rare) are kept
function dropZeroSeconds(value: string): string {
  return value.replace(/^(\d{2}:\d{2}):00$/, '$1');
}
