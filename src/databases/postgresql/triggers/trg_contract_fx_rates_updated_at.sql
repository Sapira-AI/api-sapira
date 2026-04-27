DROP TRIGGER IF EXISTS "trg_contract_fx_rates_updated_at" ON "public"."contract_fx_period_rates";

CREATE TRIGGER "trg_contract_fx_rates_updated_at"
BEFORE UPDATE
ON "public"."contract_fx_period_rates"
FOR EACH ROW
EXECUTE FUNCTION update_updated_at_column();
