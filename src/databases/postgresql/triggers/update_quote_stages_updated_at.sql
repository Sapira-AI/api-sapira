DROP TRIGGER IF EXISTS "update_quote_stages_updated_at" ON "public"."quote_stages";

CREATE TRIGGER "update_quote_stages_updated_at"
BEFORE UPDATE
ON "public"."quote_stages"
FOR EACH ROW
EXECUTE FUNCTION update_quote_stages_updated_at();
