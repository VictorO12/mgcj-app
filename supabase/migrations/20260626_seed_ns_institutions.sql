-- Seed the major Nova Scotia post-secondary institutions into the platform
-- catalog so dispatch can sponsor them from the dashboard. NSCC included
-- since it has a campus in the Valley (Kingstec, Kentville).
insert into institutions (name, domain) values
  ('Nova Scotia Community College (NSCC)', 'nscc.ca'),
  ('Dalhousie University', 'dal.ca'),
  ('Saint Mary''s University', 'smu.ca'),
  ('Mount Saint Vincent University', 'msvu.ca'),
  ('University of King''s College', 'ukings.ca'),
  ('St. Francis Xavier University', 'stfx.ca'),
  ('Cape Breton University', 'cbu.ca'),
  ('Université Sainte-Anne', 'usainteanne.ca')
on conflict (domain) do nothing;
