-- Pricing v2 (migración 1790630000000-CreatePricingV2): espejo de holding_access_contract_items. La API entra con rol
-- privilegiado y acota por holding en cada consulta; esta policy cubre el Data API del front viejo si alguna vez la lee.
DROP POLICY IF EXISTS "holding_access_consumption_entries" ON "public"."consumption_entries";

CREATE POLICY "holding_access_consumption_entries"
ON "public"."consumption_entries"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
