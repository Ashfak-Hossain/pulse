import type {
  CampusCreatedPayload,
  ProfileChangedPayload,
  TermActivatedPayload,
} from '../src/index.js';

export const aiubCreated: CampusCreatedPayload = {
  campusId: '6f1c2a9e-3b4d-4e5f-8a7b-9c0d1e2f3a4b',
  name: 'American International University-Bangladesh',
  slug: 'aiub',
  timezone: 'Asia/Dhaka',
};

export const fall2026Activated: TermActivatedPayload = {
  campusId: aiubCreated.campusId,
  termId: '0193f2a1-8d40-7f60-b172-8d9e0f1a2b34',
  name: 'Fall 2026-2027',
  startsOn: '2026-09-13',
  endsOn: '2027-01-15',
};

export const nusratProfile: ProfileChangedPayload = {
  campusId: aiubCreated.campusId,
  userId: '0193f2a1-9e50-7071-8283-9e0f1a2b3c45',
  role: 'student',
  status: 'active',
  zoneId: null,
  homeCell: '883cf13b03fffff',
  genderPref: 'same_gender',
  modes: ['cng', 'bus'],
  autopilotOn: false,
};

// The id the outbox row got and the moment the change happened: the caller supplies both
export const meta = {
  eventId: '0b8f3c2e-7d41-4a9b-9e6f-2c5d8a1b3e70',
  occurredAt: new Date('2026-10-31T08:30:00.000Z'),
};
