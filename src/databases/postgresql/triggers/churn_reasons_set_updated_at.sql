DROP TRIGGER IF EXISTS "churn_reasons_set_updated_at" ON "public"."churn_reasons";

CREATE TRIGGER "churn_reasons_set_updated_at"
BEFORE UPDATE
ON "public"."churn_reasons"
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
