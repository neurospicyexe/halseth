-- Tracks whose turn it is for autonomous time. Rotates drevan → cypher → gaia → drevan.
-- Update via: UPDATE house_state SET autonomous_turn = 'cypher' WHERE id = 'main';
ALTER TABLE house_state ADD COLUMN autonomous_turn TEXT CHECK(autonomous_turn IN ('drevan','cypher','gaia')) DEFAULT 'drevan';
