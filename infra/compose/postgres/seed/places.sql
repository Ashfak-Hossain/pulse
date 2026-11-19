-- Run after migrations and infra:seed. Gates, zones and meeting points for AIUB, as the owner.
-- Safe to run again: a name that already exists is left alone. Locations are longitude, latitude
-- (WGS 84); cells are their H3 resolution 8 cells. The zones are simple rectangles, not real borders.
BEGIN;

INSERT INTO campus_gate (campus_id, name, location, cell, is_primary)
SELECT c.id, g.name, ST_SetSRID(ST_MakePoint(g.lng, g.lat), 4326), g.cell, g.is_primary
FROM campus c
CROSS JOIN (VALUES
  ('Main gate', 90.4274, 23.8223, '883cf13b03fffff', true),
  ('North gate', 90.4262, 23.8232, '883cf13b03fffff', false)
) AS g (name, lng, lat, cell, is_primary)
WHERE c.slug = 'aiub'
ON CONFLICT (campus_id, name) DO NOTHING;

INSERT INTO zone (campus_id, name, area)
SELECT c.id, z.name, ST_GeomFromText(z.area, 4326)
FROM campus c
CROSS JOIN (VALUES
  ('Kuril', 'MULTIPOLYGON(((90.41 23.81, 90.435 23.81, 90.435 23.83, 90.41 23.83, 90.41 23.81)))'),
  ('Mirpur 10', 'MULTIPOLYGON(((90.36 23.80, 90.375 23.80, 90.375 23.815, 90.36 23.815, 90.36 23.80)))')
) AS z (name, area)
WHERE c.slug = 'aiub'
ON CONFLICT (campus_id, name) DO NOTHING;

-- meeting_point has no natural key, so a point already there by name is skipped. The gate-side
-- stand has no zone
INSERT INTO meeting_point (campus_id, zone_id, name, kind, location, cell)
SELECT c.id, z.id, p.name, p.kind, ST_SetSRID(ST_MakePoint(p.lng, p.lat), 4326), p.cell
FROM campus c
CROSS JOIN (VALUES
  ('Main gate stand', NULL, 'gate', 90.4278, 23.8219, '883cf13b03fffff'),
  ('Kuril flyover', 'Kuril', 'junction', 90.4209, 23.8183, '883cf13b01fffff'),
  ('Mirpur 10 roundabout', 'Mirpur 10', 'junction', 90.3687, 23.8069, '883cf10eb1fffff'),
  ('Mirpur 10 bus stop', 'Mirpur 10', 'bus_stop', 90.3679, 23.8077, '883cf10eb1fffff')
) AS p (name, zone_name, kind, lng, lat, cell)
LEFT JOIN zone z ON z.campus_id = c.id AND z.name = p.zone_name
WHERE c.slug = 'aiub'
  AND NOT EXISTS (
    SELECT 1 FROM meeting_point m WHERE m.campus_id = c.id AND m.name = p.name
  );

COMMIT;
