DROP TRIGGER IF EXISTS "trg_holding_settings_updated_at" ON "public"."holding_settings";

CREATE TRIGGER "trg_holding_settings_updated_at"
BEFORE UPDATE
ON "public"."holding_settings"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
