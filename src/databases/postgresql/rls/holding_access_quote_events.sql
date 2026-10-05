-- Cotizaciones v2 (migración 1790650000000-QuotesV2): espejo de holding_access_quote_items. La API entra con rol privilegiado y
-- acota por holding en cada consulta; esta policy cubre el Data API del front viejo si alguna vez la lee.
DROP POLICY IF EXISTS "holding_access_quote_events" ON "public"."quote_events";

CREATE POLICY "holding_access_quote_events"
ON "public"."quote_events"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
