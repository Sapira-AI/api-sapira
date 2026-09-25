import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retira el job `salesforce-daily-sync` y su función de monitoreo: la sincronización de Salesforce
 * la hace el scheduler de la API, no una edge function.
 *
 * **Qué hacía el job.** Todos los días a las 04:01 UTC llamaba la edge function
 * `salesforce-daily-sync` del proyecto de Supabase. Esa función quedó reemplazada por
 * `SalesforceScheduler` (`src/modules/salesforce/salesforce.scheduler.ts`, `@Cron('30 8 * * *')` en
 * `America/Santiago`), que es lo que hoy escribe `salesforce_opportunities_stg` —143 filas, último
 * insert el 2026-09-22 08:30 de Santiago, exactamente en su horario—. El propio README del módulo ya
 * declaraba el reemplazo función por función.
 *
 * **Prueba de que la edge function estaba muerta.** Ninguna fila de `salesforce_connections` tiene
 * `refresh_token`, y las dos conexiones activas de producción son `password` y `client_credentials`.
 * La edge function solo sabía renovar el token por `refresh_token`: ante el 401 de Salesforce caía
 * siempre en `Query falló`, capturado por el `try` de cada holding, y devolvía `200` igual. Por eso
 * `salesforce_opportunities_cache` está en **0 filas** y `last_sync_at` no se movía en las corridas
 * del cron. El scheduler de la API sí soporta los tres modos de autenticación.
 *
 * **Por qué el job tiene que irse junto con la edge function.** Al borrarla del proyecto, el job
 * seguiría pegándole a una URL inexistente todos los días: `cron.job_run_details` lo registraría como
 * `succeeded` —pg_net solo encola el pedido— y el 404 quedaría enterrado en `net._http_response`,
 * que se purga a las pocas horas. Un job que falla en silencio es peor que no tenerlo.
 *
 * **`check_salesforce_sync_cron_status()`** consulta `cron.job WHERE jobname = 'salesforce-daily-sync'`
 * y nada más: sin el job devuelve siempre vacío. No la llama nadie en `api-sapira` ni en
 * `front-sapira-vite`.
 *
 * El `DO` guarda dos casos: una base sin pg_cron (`to_regclass` nulo) y una base donde el job ya no
 * está. `cron.unschedule` levanta excepción si el nombre no existe, así que el `IF EXISTS` es lo que
 * hace la migración re-ejecutable sobre entornos que no estaban sincronizados.
 *
 * El `down()` reprograma el job con el comando vigente —el que pasa por
 * `public.cron_invoke_edge_function`, sin secretos— y restaura la función verbatim. Revertir esto no
 * revive la edge function: eso es un `supabase functions deploy` desde `front-sapira-vite`.
 */
export class RetiraSincronizacionSalesforcePorEdgeFunction1790163360141 implements MigrationInterface {
	name = 'RetiraSincronizacionSalesforcePorEdgeFunction1790163360141';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`
			DO $$
			BEGIN
				IF to_regclass('cron.job') IS NOT NULL
					AND EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'salesforce-daily-sync') THEN
					PERFORM cron.unschedule('salesforce-daily-sync');
				END IF;
			END
			$$
		`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.check_salesforce_sync_cron_status()`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`
			CREATE OR REPLACE FUNCTION public.check_salesforce_sync_cron_status()
			 RETURNS TABLE(jobname text, schedule text, active boolean, last_run timestamp with time zone, next_run timestamp with time zone)
			 LANGUAGE plpgsql
			 SECURITY DEFINER
			AS $function$
			BEGIN
			  RETURN QUERY
			  SELECT
			    j.jobname::TEXT,
			    j.schedule::TEXT,
			    j.active,
			    j.last_run,
			    j.next_run
			  FROM cron.job j
			  WHERE j.jobname = 'salesforce-daily-sync';
			END;
			$function$
		`);
		await queryRunner.query(`
			DO $$
			BEGIN
				IF to_regclass('cron.job') IS NOT NULL THEN
					PERFORM cron.schedule(
						'salesforce-daily-sync',
						'1 4 * * *',
						$cron$SELECT public.cron_invoke_edge_function('salesforce-daily-sync', 'GET')$cron$
					);
				END IF;
			END
			$$
		`);
	}
}
