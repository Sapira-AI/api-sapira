-- Catálogo global del Banco Central (UF, dólar observado, TPM, IPC…): sin `holding_id`, sin datos
-- por tenant y sin flag de activo, así que la lectura es completa. Las escrituras las hace
-- `modules/banco-central/banco-central.service.ts` con el rol que tiene bypass.
--
-- Hoy el front llega a estos datos por la API NestJS (`hooks/useBancoCentral.ts`), no por
-- supabase-js. La policy existe para que activar RLS no cierre una puerta que mañana sea legítimo
-- abrir, no porque haya un consumidor esperándola.
--
-- `TO authenticated` y no `TO public`: `public` incluye a `anon`.

DROP POLICY IF EXISTS "indicadores_economicos_select" ON "public"."indicadores_economicos";

CREATE POLICY "indicadores_economicos_select"
ON "public"."indicadores_economicos"
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (true);
