import { describe, expect, it } from 'vitest';
import { topics } from '../src/index.js';

const all = Object.values(topics);

// Mirrors the topic table in docs/architecture.md (topic name → message key); update both together
const architecture: Record<string, string> = {
  campuses: 'campusId',
  'trip-requests': 'campusId',
  trips: 'tripId',
  calendar: 'sectionId',
  ledger: 'crewId',
  locations: 'tripId',
  profiles: 'userId',
};

describe('topics', () => {
  it('lists exactly the topics in docs/architecture.md, with the same keys', () => {
    const keys = Object.fromEntries(all.map((topic) => [topic.name, topic.key]));
    expect(keys).toEqual(architecture);
  });

  it('never uses one name twice', () => {
    const names = all.map((topic) => topic.name);
    expect(new Set(names).size).toBe(names.length);
  });

  // Kafka allows letters, digits, '.', '_' and '-'; '.' and '_' collide in metric names, so
  // Pulse uses lowercase words joined by '-'
  it.each(all.map((topic) => [topic.name]))('%s is a legal, lowercase-hyphen name', (name) => {
    expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it.each(all.map((topic) => [topic.name, topic.partitions]))(
    '%s has a whole, positive partition count',
    (_name, partitions) => {
      expect(Number.isInteger(partitions)).toBe(true);
      expect(partitions).toBeGreaterThan(0);
    },
  );

  it('compacts profiles, so Kafka keeps the latest value per user', () => {
    expect(topics.profiles.config['cleanup.policy']).toBe('compact');
  });

  it('keeps locations for a short time only (at most one day)', () => {
    const retentionMs = Number(topics.locations.config['retention.ms']);
    expect(retentionMs).toBeGreaterThan(0);
    expect(retentionMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });

  // Kafka reads every config value as a string; a number here would fail at topic creation
  it('gives every config value as a string', () => {
    for (const topic of all) {
      for (const value of Object.values(topic.config)) expect(typeof value).toBe('string');
    }
  });
});
