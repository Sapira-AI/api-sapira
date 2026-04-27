DROP TRIGGER IF EXISTS "trg_z_fix_renewal_annual" ON "public"."contract_items";

CREATE TRIGGER "trg_z_fix_renewal_annual"
BEFORE INSERT
ON "public"."contract_items"
FOR EACH ROW
EXECUTE FUNCTION fix_renewal_annual_fields();
