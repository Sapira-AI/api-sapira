DROP TRIGGER IF EXISTS "trg_invoice_collection_settings_updated_at" ON "public"."invoice_collection_settings";

CREATE TRIGGER "trg_invoice_collection_settings_updated_at"
BEFORE UPDATE
ON "public"."invoice_collection_settings"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
