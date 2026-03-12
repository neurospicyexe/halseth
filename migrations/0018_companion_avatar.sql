-- Links a companion to an R2 asset for avatar display in Hearth.
-- Set via:   UPDATE companion_config SET avatar_asset_id = '<asset-id>' WHERE id = 'drevan';
-- Clear via: UPDATE companion_config SET avatar_asset_id = NULL WHERE id = 'drevan';
ALTER TABLE companion_config ADD COLUMN avatar_asset_id TEXT;
