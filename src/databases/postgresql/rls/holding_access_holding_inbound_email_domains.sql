-- Dominio de recepción de DTE (migración 1792000000000-CreateHoldingInboundEmailDomains): espejo de
-- holding_access_invoice_consolidation_rules. La API entra con rol privilegiado y acota por holding en cada consulta; esta policy
-- cubre el Data API si alguna vez la lee.
DROP POLICY IF EXISTS "holding_access_holding_inbound_email_domains" ON "public"."holding_inbound_email_domains";

CREATE POLICY "holding_access_holding_inbound_email_domains"
ON "public"."holding_inbound_email_domains"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
