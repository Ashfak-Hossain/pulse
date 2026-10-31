import type { CampusCreatedPayload } from '../src/index.js';

export const aiubCreated: CampusCreatedPayload = {
  campusId: '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b',
  name: 'American International University-Bangladesh',
  slug: 'aiub',
  timezone: 'Asia/Dhaka',
};

// The id the outbox row got and the moment the change happened: the caller supplies both
export const meta = {
  eventId: '0b8f3c2e-7d41-4a9b-9e6f-2c5d8a1b3e70',
  occurredAt: new Date('2026-10-31T08:30:00.000Z'),
};
