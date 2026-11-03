-- Run after db:migrate and infra:seed, as the owner. Re-running keeps existing courses.
insert into course (campus_id, code, title)
select c.id, seed.code, seed.title
from campus c
cross join (values
  ('CSC4161', 'Advanced Programming in Web Technology'),
  ('CSC2105', 'Data Structures'),
  ('CSC2209', 'Object Oriented Programming 1')
) as seed(code, title)
where c.slug = 'aiub'
on conflict (campus_id, code) do nothing;
