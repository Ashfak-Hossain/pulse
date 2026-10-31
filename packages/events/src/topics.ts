// Every Kafka topic Pulse uses
export interface TopicSpec {
  readonly name: string;
  // The payload field used as the message key. Same key → same partition → read in order
  readonly key: string;
  // Can only grow, and growing it moves keys to other partitions
  readonly partitions: number;
  readonly config: Readonly<Record<string, string>>;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export const topics = {
  // Campus lifecycle (CampusCreated)
  campuses: {
    name: 'campuses',
    key: 'campusId',
    partitions: 1,
    config: {},
  },
  tripRequests: {
    name: 'trip-requests',
    key: 'campusId',
    partitions: 3,
    config: {},
  },
  trips: {
    name: 'trips',
    key: 'tripId',
    partitions: 3,
    config: {},
  },
  calendar: {
    name: 'calendar',
    key: 'sectionId',
    partitions: 3,
    config: {},
  },
  ledger: {
    name: 'ledger',
    key: 'crewId',
    partitions: 3,
    config: {},
  },
  locations: {
    name: 'locations',
    key: 'tripId',
    partitions: 3,
    config: { 'retention.ms': String(ONE_DAY_MS) },
  },
  profiles: {
    name: 'profiles',
    key: 'userId',
    partitions: 3,
    config: { 'cleanup.policy': 'compact' },
  },
} as const satisfies Record<string, TopicSpec>;

export type TopicName = (typeof topics)[keyof typeof topics]['name'];
