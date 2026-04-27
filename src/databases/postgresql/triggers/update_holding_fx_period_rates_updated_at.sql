DROP TRIGGER IF EXISTS "update_holding_fx_period_rates_updated_at" ON "public"."holding_fx_period_rates";

CREATE TRIGGER "update_holding_fx_period_rates_updated_at"
BEFORE UPDATE
ON "public"."holding_fx_period_rates"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
