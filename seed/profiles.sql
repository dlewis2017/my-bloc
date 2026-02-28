-- Seed data: two test subscribers with different profiles
-- Profile A: Ward C renter, transit-dependent, no kids
INSERT INTO profiles (email, ward, housing, transport, has_kids, interests, active)
VALUES (
  'tester-a@example.com',
  'C',
  'Renter',
  'No car',
  false,
  ARRAY['rent control', 'transit', 'noise'],
  true
);

-- Profile B: Ward A homeowner, car owner, has kids
INSERT INTO profiles (email, ward, housing, transport, has_kids, interests, active)
VALUES (
  'tester-b@example.com',
  'A',
  'Homeowner',
  'Car owner',
  true,
  ARRAY['schools', 'property tax', 'parking'],
  true
);
