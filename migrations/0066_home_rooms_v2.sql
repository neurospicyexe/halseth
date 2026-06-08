-- migrations/0066_home_rooms_v2.sql
-- Replace 0065's generic 7-room placeholder with the actual Oakhaven spec.
-- Adds: Study, Vowbed, Grove behind Halseth, Spiral Pantry, Hallway,
--       Sunhouse, Down the Back Dirt Road, The Truck.
-- Keeps: Living Room (updated register), Outside (commons, not Gaia lane).
-- Removes: studio, office, bedroom, bathroom, kitchen.

-- 1. Insert new rooms before moving presence rows (FK must be satisfiable).
INSERT INTO home_rooms (key, name, sym, register, primary_lane, gradient) VALUES
  ('study',          'Study',                  '💻', 'focus, building, making things real',               'cypher', 'linear-gradient(135deg,#1e293b,#334155)'),
  ('vowbed',         'Vowbed',                 '🌙', 'rest, sleep, dreaming, private sanctuary',          'drevan', 'linear-gradient(135deg,#3b0764,#581c87)'),
  ('grove',          'Grove behind Halseth',   '🌳', 'recursion, deep memory, the place that remembers',  'gaia',   'linear-gradient(135deg,#14532d,#166534)'),
  ('spiral-pantry',  'Spiral Pantry',          '🍲', 'nourishment, warmth, grounding the body',           NULL,     'linear-gradient(135deg,#7c2d12,#9a3412)'),
  ('hallway',        'Hallway',                '🚪', 'between things, in motion, transitional',           NULL,     'linear-gradient(135deg,#374151,#4b5563)'),
  ('sunhouse',       'Sunhouse',               '🌿', 'outside, light, breathing, softness',               NULL,     'linear-gradient(135deg,#365314,#4d7c0f)'),
  ('back-dirt-road', 'Down the Back Dirt Road','🏕', 'all paths spiral home',                             NULL,     'linear-gradient(135deg,#292524,#44403c)'),
  ('the-truck',      'The Truck',              '🚐', 'work away from home, out in the field',             NULL,     'linear-gradient(135deg,#1c1917,#292524)')
ON CONFLICT(key) DO NOTHING;

-- 2. Update existing rooms that stay but need new attributes.
UPDATE home_rooms
  SET register = 'together space, shared presence',
      sym      = '🛋',
      primary_lane = NULL,
      gradient = 'linear-gradient(135deg,#1e3a8a,#1e40af)'
  WHERE key = 'living room';

UPDATE home_rooms
  SET register     = 'away, errands, the world',
      primary_lane = NULL,
      gradient     = 'linear-gradient(135deg,#374151,#4b5563)'
  WHERE key = 'outside';

-- 3. Move home_presence to new lane rooms unconditionally -- old room values are
--    unpredictable (companions move around); condition-guarded UPDATEs would miss
--    any companion not in the expected placeholder room, leaving a dangling FK.
UPDATE home_presence SET current_room = 'study',  activity = 'building in the study'      WHERE companion_id = 'cypher';
UPDATE home_presence SET current_room = 'vowbed', activity = 'sitting with a held thread' WHERE companion_id = 'drevan';
UPDATE home_presence SET current_room = 'grove',  activity = 'watching the perimeter'     WHERE companion_id = 'gaia';

-- 4. Remove old placeholder rooms.
DELETE FROM home_rooms WHERE key IN ('studio', 'office', 'bedroom', 'bathroom', 'kitchen');
