-- Onboarding de datos históricos (migración 1791900000000-OnboardingDatosHistoricos): espejo de holding_access_invoice_consolidation_rules.
-- La API entra con rol privilegiado y acota por holding en cada consulta; esta policy cubre el Data API si alguna vez la lee.
DROP POLICY IF EXISTS "holding_access_onboarding_events" ON "public"."onboarding_events";

CREATE POLICY "holding_access_onboarding_events"
ON "public"."onboarding_events"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
