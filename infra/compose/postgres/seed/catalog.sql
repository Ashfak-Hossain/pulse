-- Run after migrations, infra:seed and infra:seed:courses. The sections are synthetic.
BEGIN;

INSERT INTO term (campus_id, name, starts_on, ends_on, status)
SELECT id, 'Fall 2026-2027', DATE '2026-09-13', DATE '2027-01-15', 'active'
FROM campus
WHERE slug = 'aiub'
ON CONFLICT DO NOTHING;

INSERT INTO section (
  campus_id, term_id, course_id, external_class_id, section_label, title,
  capacity, enrolled, status
)
SELECT t.campus_id, t.id, c.id, sample.class_id, sample.label, c.title,
       sample.capacity, sample.enrolled, sample.status
FROM term t
JOIN campus a ON a.id = t.campus_id AND a.slug = 'aiub'
CROSS JOIN (VALUES
  ('CSC4161', 'demo-web-a', 'A', 50, 52, 'open'),
  ('CSC2105', 'demo-ds-b', 'B', 45, 32, 'reserved'),
  ('CSC2209', 'demo-oop-a', 'A', 40, 0, 'freshman')
) AS sample (code, class_id, label, capacity, enrolled, status)
JOIN course c ON c.campus_id = t.campus_id AND c.code = sample.code
WHERE t.name = 'Fall 2026-2027'
ON CONFLICT (term_id, external_class_id) DO NOTHING;

-- Stable fixture keys make repeated or concurrent seeds skip the same meetings.
INSERT INTO section_meeting (
  id, campus_id, section_id, kind, weekday, start_time, end_time, room
)
SELECT sample.id::uuid, s.campus_id, s.id, sample.kind, sample.weekday,
       sample.starts, sample.ends, sample.room
FROM section s
JOIN term t ON t.id = s.term_id AND t.name = 'Fall 2026-2027'
JOIN campus a ON a.id = t.campus_id AND a.slug = 'aiub'
JOIN (VALUES
  ('019a1000-0000-7000-8000-000000000001', 'demo-web-a', 'theory', 0, TIME '14:00', TIME '15:20', '6202'),
  ('019a1000-0000-7000-8000-000000000002', 'demo-web-a', 'lab', 2, TIME '14:00', TIME '15:20', 'DE0401'),
  ('019a1000-0000-7000-8000-000000000003', 'demo-ds-b', 'theory', 1, TIME '09:00', TIME '10:20', NULL)
) AS sample (id, class_id, kind, weekday, starts, ends, room)
ON s.external_class_id = sample.class_id
ON CONFLICT (id) DO NOTHING;

COMMIT;
