DROP TRIGGER IF EXISTS "validate_fx_before_firmado" ON "public"."contracts";

CREATE TRIGGER "validate_fx_before_firmado"
BEFORE UPDATE
ON "public"."contracts"
FOR EACH ROW
EXECUTE FUNCTION validate_fx_confirmation_before_firmado();
