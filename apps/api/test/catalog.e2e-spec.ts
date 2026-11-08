import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { apiErrorSchema, sectionListSchema, termListSchema } from '@pulse/contracts';
import { campus, course, createDb, section, sectionMeeting, term, type Database } from '@pulse/db';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { inject } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import { DATABASE } from '../src/db/db.module.js';

const suffix = randomUUID().slice(0, 8);
const a = {
  id: randomUUID(),
  name: 'Catalog Campus A',
  slug: 'catalog-a-' + suffix,
  emailDomains: ['a.catalog-' + suffix + '.test'],
  location: { x: 90.4, y: 23.8 },
  timezone: 'Asia/Dhaka',
};
const b = {
  ...a,
  id: randomUUID(),
  name: 'Catalog Campus B',
  slug: 'catalog-b-' + suffix,
  emailDomains: ['b.catalog-' + suffix + '.test'],
};
const active = {
  id: randomUUID(),
  campusId: a.id,
  name: 'Fall 2026-2027',
  startsOn: '2026-09-01',
  endsOn: '2027-01-01',
  status: 'active',
} as const;
const archived = {
  ...active,
  id: randomUUID(),
  name: 'Spring 2025-2026',
  startsOn: '2026-02-01',
  endsOn: '2026-06-01',
  status: 'archived',
} as const;
const draft = {
  ...active,
  id: randomUUID(),
  name: 'Spring 2026-2027',
  startsOn: '2027-02-01',
  endsOn: '2027-06-01',
  status: 'draft',
} as const;
const other = { ...active, id: randomUUID(), campusId: b.id };
const computing = {
  id: randomUUID(),
  campusId: a.id,
  code: 'CSC1001',
  title: 'Computing Fundamentals',
};
const engineering = {
  ...computing,
  id: randomUUID(),
  code: 'ENG2001',
  title: 'Technical Communication',
};
const common = {
  campusId: a.id,
  termId: active.id,
  courseId: computing.id,
  capacity: 40,
  enrolled: 42,
  status: 'open',
  instructorName: null,
} as const;
const first = {
  ...common,
  id: randomUUID(),
  externalClassId: '00001',
  sectionLabel: 'A',
  title: 'Programming 100%',
};
const second = {
  ...common,
  id: randomUUID(),
  externalClassId: '00002',
  sectionLabel: 'A',
  title: 'Programming Practicum',
};
const third = {
  ...common,
  id: randomUUID(),
  externalClassId: '00003',
  sectionLabel: 'B',
  title: 'Computing Workshop',
};
const fourth = {
  ...common,
  id: randomUUID(),
  courseId: engineering.id,
  externalClassId: '00004',
  sectionLabel: 'A',
  title: 'Documentation A_B \\ C',
};
const order = [[first.id, second.id].sort(), [third.id, fourth.id]].flat();
const termsUrl = '/campuses/' + a.slug + '/terms';
const sectionsUrl = '/campuses/' + a.slug + '/sections';

describe('public campus catalog', () => {
  let app: INestApplication<App>;
  let owner: Database;

  beforeAll(async () => {
    owner = createDb(inject('ownerUrl'));
    await owner.insert(campus).values([a, b]);
    await owner.insert(term).values([archived, active, draft, other]);
    await owner.insert(course).values([computing, engineering]);
    await owner.insert(section).values([fourth, second, third, first]);
    await owner.insert(sectionMeeting).values([
      {
        campusId: a.id,
        sectionId: first.id,
        kind: 'lab',
        weekday: 2,
        startTime: '15:00',
        endTime: '16:20',
        room: 'LAB',
      },
      {
        campusId: a.id,
        sectionId: first.id,
        kind: 'theory',
        weekday: 0,
        startTime: '14:00',
        endTime: '15:20',
        room: null,
      },
      {
        campusId: a.id,
        sectionId: first.id,
        kind: 'other',
        weekday: 2,
        startTime: '09:00:15',
        endTime: '10:20',
        room: 'STUDIO',
      },
    ]);
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useFactory({ factory: () => createDb(inject('appUrl')) })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await owner?.$client.end();
  });

  it('returns visible terms newest first without another campus or drafts', async () => {
    const res = await request(app.getHttpServer()).get(termsUrl).expect(200);
    expect(termListSchema.parse(res.body).items).toEqual(
      [active, archived].map(({ id, name, startsOn, endsOn, status }) => ({
        id,
        name,
        startsOn,
        endsOn,
        status,
      })),
    );
  });

  it('returns every visible term, even past fifty', async () => {
    const past = Array.from({ length: 55 }, (_, index) => ({
      campusId: b.id,
      name: 'Archived ' + String(index),
      startsOn: String(1960 + index) + '-01-01',
      endsOn: String(1960 + index) + '-06-01',
      status: 'archived' as const,
    }));
    await owner.insert(term).values(past);
    const res = await request(app.getHttpServer())
      .get('/campuses/' + b.slug + '/terms')
      .expect(200);
    const items = termListSchema.parse(res.body).items;
    expect(items).toHaveLength(56);
    expect(items[0]?.id).toBe(other.id);
    expect(items.at(-1)?.name).toBe('Archived 0');
  });

  it('orders sections by course, label and UUID and batches sorted meetings', async () => {
    const res = await request(app.getHttpServer())
      .get(sectionsUrl)
      .query({ termId: active.id })
      .expect(200);
    const page = sectionListSchema.parse(res.body);
    expect(page.nextCursor).toBeNull();
    expect(page.items.map(({ id }) => id)).toEqual(order);
    expect(page.items.find(({ id }) => id === first.id)).toEqual({
      id: first.id,
      termId: active.id,
      course: { code: computing.code, title: computing.title },
      title: first.title,
      sectionLabel: 'A',
      status: 'open',
      capacity: 40,
      enrolled: 42,
      instructorName: null,
      meetings: [
        { kind: 'theory', weekday: 0, startTime: '14:00', endTime: '15:20', room: null },
        { kind: 'other', weekday: 2, startTime: '09:00:15', endTime: '10:20', room: 'STUDIO' },
        { kind: 'lab', weekday: 2, startTime: '15:00', endTime: '16:20', room: 'LAB' },
      ],
    });
    expect(page.items.find(({ id }) => id === second.id)?.meetings).toEqual([]);
  });

  it('walks every section exactly once across single-item pages', async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < order.length; page++) {
      const res = await request(app.getHttpServer())
        .get(sectionsUrl)
        .query({ termId: active.id, limit: 1, ...(cursor === null ? {} : { cursor }) })
        .expect(200);
      const result = sectionListSchema.parse(res.body);
      expect(result.items).toHaveLength(1);
      ids.push(...result.items.map(({ id }) => id));
      cursor = result.nextCursor;
    }
    expect(ids).toEqual(order);
    expect(cursor).toBeNull();
  });

  it.each([
    ['eng2001', [fourth.id]],
    ['communication', [fourth.id]],
    ['practicum', [second.id]],
    ['%', [first.id]],
    ['A_B', [fourth.id]],
    ['\\ C', [fourth.id]],
  ] as const)('searches %s literally and case-insensitively', async (q, ids) => {
    const res = await request(app.getHttpServer())
      .get(sectionsUrl)
      .query({ termId: active.id, q })
      .expect(200);
    expect(sectionListSchema.parse(res.body).items.map(({ id }) => id)).toEqual(ids);
  });

  it('returns an empty page for a visible term without sections', async () => {
    const res = await request(app.getHttpServer())
      .get(sectionsUrl)
      .query({ termId: archived.id })
      .expect(200);
    expect(sectionListSchema.parse(res.body)).toEqual({ items: [], nextCursor: null });
  });

  it.each([other.id, draft.id, randomUUID()])('hides an inaccessible term %s', async (termId) => {
    const res = await request(app.getHttpServer()).get(sectionsUrl).query({ termId }).expect(404);
    expect(apiErrorSchema.parse(res.body).message).toBe('Term not found');
  });

  it('returns 404 for unknown campus slugs on both routes', async () => {
    const base = '/campuses/missing-' + suffix;
    const res = await request(app.getHttpServer())
      .get(base + '/terms')
      .expect(404);
    expect(apiErrorSchema.parse(res.body).message).toBe('Campus not found');
    await request(app.getHttpServer())
      .get(base + '/sections')
      .query({ termId: active.id })
      .expect(404);
  });

  it.each([
    'bad!',
    'bm90LWpzb24',
    Buffer.concat([
      Buffer.from('{"code":"'),
      Buffer.from([0xff]),
      Buffer.from('","sectionLabel":"A","id":"' + first.id + '"}'),
    ]).toString('base64url'),
    Buffer.from(JSON.stringify({ code: 'a\0b', sectionLabel: 'A', id: first.id })).toString(
      'base64url',
    ),
  ])('rejects invalid cursors with 400', async (cursor) => {
    const res = await request(app.getHttpServer())
      .get(sectionsUrl)
      .query({ termId: active.id, cursor })
      .expect(400);
    expect(apiErrorSchema.parse(res.body).statusCode).toBe(400);
  });
});
