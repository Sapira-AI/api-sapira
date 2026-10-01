-- Bloque Modificaciones B2 (migración 1790710000000-ContractModificationsBlock2): misma regla que contract_fx_period_rates.
DROP POLICY IF EXISTS "tenant_isolation_delete_contract_item_pauses" ON "public"."contract_item_pauses";

CREATE POLICY "tenant_isolation_delete_contract_item_pauses"
ON "public"."contract_item_pauses"
AS PERMISSIVE
FOR DELETE
TO public
USING (((holding_id = get_current_user_holding_id()) AND (contract_id IN ( SELECT contracts.id
   FROM contracts
  WHERE (contracts.holding_id = get_current_user_holding_id())))));
