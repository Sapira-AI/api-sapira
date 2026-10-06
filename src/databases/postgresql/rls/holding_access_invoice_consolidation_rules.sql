-- Unificación recurrente (migración 1791800000000-CreateInvoiceConsolidationRules): espejo de holding_access_consumption_entries. La API
-- entra con rol privilegiado y acota por holding en cada consulta; esta policy cubre el Data API si alguna vez la lee.
DROP POLICY IF EXISTS "holding_access_invoice_consolidation_rules" ON "public"."invoice_consolidation_rules";

CREATE POLICY "holding_access_invoice_consolidation_rules"
ON "public"."invoice_consolidation_rules"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
