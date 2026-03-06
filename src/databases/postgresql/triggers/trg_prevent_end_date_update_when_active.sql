DROP TRIGGER IF EXISTS "trg_prevent_end_date_update_when_active" ON "public"."contracts";

CREATE TRIGGER "trg_prevent_end_date_update_when_active"
BEFORE UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION prevent_end_date_update_when_active();
