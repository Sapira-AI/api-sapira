DROP POLICY IF EXISTS "tenant_isolation_delete_contract_fx_rates_enhanced" ON "public"."contract_fx_period_rates";

CREATE POLICY "tenant_isolation_delete_contract_fx_rates_enhanced"
ON "public"."contract_fx_period_rates"
AS PERMISSIVE
FOR DELETE
TO public
USING (((holding_id = get_current_user_holding_id()) AND (contract_id IN ( SELECT contracts.id
   FROM contracts
  WHERE (contracts.holding_id = get_current_user_holding_id())))));
