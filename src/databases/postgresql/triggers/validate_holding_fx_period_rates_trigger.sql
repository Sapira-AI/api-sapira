DROP TRIGGER IF EXISTS "validate_holding_fx_period_rates_trigger" ON "public"."holding_fx_period_rates";

CREATE TRIGGER "validate_holding_fx_period_rates_trigger"
BEFORE INSERT OR UPDATE
ON "public"."holding_fx_period_rates"
FOR EACH ROW
EXECUTE FUNCTION validate_holding_fx_period_rates();
