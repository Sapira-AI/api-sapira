-- "Importar para actualizar" clientes (migración 1792200000000-CreateImportBatches): espejo de holding_access_onboarding_events.
-- La API entra con rol privilegiado y acota por holding en cada consulta; esta policy cubre el Data API si alguna vez la lee.
DROP POLICY IF EXISTS "holding_access_import_batch_rows" ON "public"."import_batch_rows";

CREATE POLICY "holding_access_import_batch_rows"
ON "public"."import_batch_rows"
AS PERMISSIVE
FOR ALL
TO public
USING ((holding_id = get_current_user_holding_id()));
