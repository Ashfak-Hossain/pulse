-- Local development data, loaded with `pnpm infra:seed` (after db:migrate) as the owner.
-- Safe to run again: a slug that already exists is left alone.
-- Location is longitude, latitude (WGS 84). The demo campus is made up (.test is a reserved domain).
insert into campus (name, slug, email_domains, location, timezone)
values
  (
    'American International University-Bangladesh',
    'aiub',
    array['aiub.edu', 'student.aiub.edu'],
    ST_SetSRID(ST_MakePoint(90.4274, 23.8223), 4326),
    'Asia/Dhaka'
  ),
  (
    'Pulse Demo Campus',
    'demo',
    array['demo.pulse.test'],
    ST_SetSRID(ST_MakePoint(90.4125, 23.8103), 4326),
    'Asia/Dhaka'
  )
on conflict (slug) do nothing;
