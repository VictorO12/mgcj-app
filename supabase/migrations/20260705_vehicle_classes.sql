-- Vehicle classes: per-company ride tiers with surcharge pricing
-- Supports multi-class fleets (e.g. Sedan/Van/SUV); single-class companies
-- get one "Standard" class seeded below and the UI adapts automatically.

-- ─── New table ───────────────────────────────────────────────────────────────

CREATE TABLE vehicle_classes (
  id                uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id        uuid        REFERENCES companies(id) ON DELETE CASCADE NOT NULL,
  name              text        NOT NULL,
  capacity          int         NOT NULL DEFAULT 4,
  surcharge_percent numeric(5,2) NOT NULL DEFAULT 0,
  display_order     int         NOT NULL DEFAULT 0,
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz DEFAULT now(),
  UNIQUE(company_id, name)
);

CREATE INDEX ON vehicle_classes(company_id);

GRANT SELECT ON vehicle_classes TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON vehicle_classes TO authenticated;

ALTER TABLE vehicle_classes ENABLE ROW LEVEL SECURITY;

-- Passengers need to read classes at booking time but don't have a company_id
-- on their profile, so SELECT is open to all authenticated users.
CREATE POLICY "Read vehicle classes"
  ON vehicle_classes FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Admins insert vehicle classes"
  ON vehicle_classes FOR INSERT TO authenticated
  WITH CHECK (company_id = get_my_company_id());

CREATE POLICY "Admins update vehicle classes"
  ON vehicle_classes FOR UPDATE TO authenticated
  USING (company_id = get_my_company_id())
  WITH CHECK (company_id = get_my_company_id());

CREATE POLICY "Admins delete vehicle classes"
  ON vehicle_classes FOR DELETE TO authenticated
  USING (company_id = get_my_company_id());

-- ─── Existing tables ─────────────────────────────────────────────────────────

ALTER TABLE drivers
  ADD COLUMN vehicle_class_id uuid REFERENCES vehicle_classes(id) ON DELETE SET NULL;

CREATE INDEX ON drivers(vehicle_class_id);

ALTER TABLE rides
  ADD COLUMN vehicle_class_id uuid REFERENCES vehicle_classes(id) ON DELETE SET NULL;

CREATE INDEX ON rides(vehicle_class_id);

-- ─── Seed existing data ──────────────────────────────────────────────────────

-- One "Standard" class per existing company (0% surcharge, capacity 7 for
-- Caravan fleets — update manually if a company's default differs).
INSERT INTO vehicle_classes (company_id, name, capacity, surcharge_percent, display_order)
SELECT id, 'Standard', 7, 0, 0
FROM companies;

-- Assign all existing drivers to their company's Standard class.
UPDATE drivers d
SET vehicle_class_id = vc.id
FROM profiles p
JOIN vehicle_classes vc
  ON vc.company_id = p.company_id
  AND vc.name = 'Standard'
WHERE d.id = p.id;
