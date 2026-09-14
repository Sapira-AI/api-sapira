DROP TRIGGER IF EXISTS "sapira_quantity_imports_set_updated_at" ON "public"."sapira_quantity_imports";

CREATE TRIGGER "sapira_quantity_imports_set_updated_at"
BEFORE UPDATE
ON "public"."sapira_quantity_imports"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
