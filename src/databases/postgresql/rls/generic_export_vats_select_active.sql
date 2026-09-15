-- Catálogo global de VATs de exportación: no tiene `holding_id`, así que no hay aislamiento
-- por tenant que declarar. Se abre la lectura de las filas activas y nada más; las escrituras
-- quedan para el rol con bypass, que es quien las hace hoy (`common/services/generic-vats.service.ts`).
--
-- `TO authenticated` y no `TO public`: `public` incluye a `anon`, que es exactamente a quien este
-- cambio le está sacando el acceso. La convención vieja del repo —`rls/Anyone can view active
-- currencies.sql`— usa `TO public`; no la copiamos acá a propósito.

DROP POLICY IF EXISTS "generic_export_vats_select_active" ON "public"."generic_export_vats";

CREATE POLICY "generic_export_vats_select_active"
ON "public"."generic_export_vats"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING ((is_active = true));
