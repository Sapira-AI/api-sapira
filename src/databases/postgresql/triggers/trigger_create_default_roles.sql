DROP TRIGGER IF EXISTS "trigger_create_default_roles" ON "public"."company_holdings";

CREATE TRIGGER "trigger_create_default_roles"
AFTER INSERT
ON "public"."company_holdings"
FOR EACH ROW
EXECUTE FUNCTION create_default_roles_for_holding();
