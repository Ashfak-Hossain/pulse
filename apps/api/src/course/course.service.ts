import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { CourseList } from '@pulse/contracts';
import { asc, campus, course, eq, withCampus, type Database } from '@pulse/db';
import { DATABASE } from '../db/db.module.js';

const COURSE_LIST_LIMIT = 500;

@Injectable()
export class CourseService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async list(slug: string): Promise<CourseList> {
    const [tenant] = await this.db
      .select({ id: campus.id })
      .from(campus)
      .where(eq(campus.slug, slug))
      .limit(1);
    if (!tenant) throw new NotFoundException('Campus not found');
    const rows = await withCampus(this.db, tenant.id, (tx) =>
      tx
        .select({ id: course.id, code: course.code, title: course.title })
        .from(course)
        .orderBy(asc(course.code), asc(course.id))
        .limit(COURSE_LIST_LIMIT),
    );
    return { items: rows.map((row) => ({ id: row.id, code: row.code, title: row.title })) };
  }
}
