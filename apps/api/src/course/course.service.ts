import { Inject, Injectable } from '@nestjs/common';
import { courseCursorSchema, type CourseList, type CourseQuery } from '@pulse/contracts';
import { asc, course, gt, withCampus, type Database } from '@pulse/db';
import { CampusService } from '../campus/campus.service.js';
import { decodeCursor, encodeCursor } from '../common/cursor.js';
import { DATABASE } from '../db/db.module.js';

@Injectable()
export class CourseService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly campuses: CampusService,
  ) {}

  /** One page of a campus's courses in code order; nextCursor is null on the last page. */
  async list(slug: string, query: CourseQuery): Promise<CourseList> {
    const cursor = query.cursor ? decodeCursor(query.cursor, courseCursorSchema) : null;
    const campusId = await this.campuses.idBySlug(slug);
    const rows = await withCampus(this.db, campusId, (tx) =>
      tx
        .select({ id: course.id, code: course.code, title: course.title })
        .from(course)
        // The (campus_id, code) unique index serves both the filter and the order
        .where(cursor ? gt(course.code, cursor.code) : undefined)
        .orderBy(asc(course.code))
        // One extra row says whether another page exists, without a count query
        .limit(query.limit + 1),
    );
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor: rows.length > query.limit && last ? encodeCursor({ code: last.code }) : null,
    };
  }
}
