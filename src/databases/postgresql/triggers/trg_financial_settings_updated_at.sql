DROP TRIGGER IF EXISTS "trg_financial_settings_updated_at" ON "public"."financial_settings";

CREATE TRIGGER "trg_financial_settings_updated_at"
BEFORE UPDATE
ON "public"."financial_settings"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
