import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Elimina `public.integration_logs` y las 6 funciones que la alimentaban.
 *
 * Los logs de integración se migraron a MongoDB: `OdooIntegrationLogService` y
 * `StripeIntegrationLogService` los escriben desde `odoo.service.ts` y
 * `stripe-ingestion.service.ts`, los mismos servicios que antes escribían acá.
 *
 * Verificado en producción el 2026-09-09 antes de escribir esta migración:
 *  - 1378 filas históricas, **0 escrituras en los últimos 30 días** (última: 2026-04-27).
 *  - Ninguna FK apunta a la tabla; solo tiene 3 FKs salientes.
 *  - Ninguna de las 6 funciones está atada a un trigger, agendada en `pg_cron`
 *    (4 jobs activos, ninguno la invoca) ni referenciada desde el código de
 *    `api-sapira` o `front-sapira-vite`.
 *  - 5 de las 6 son además inejecutables: su `INSERT` usa la columna `created_at`,
 *    que no existe en la tabla, y pasa `NULL` a `holding_id`, que es `NOT NULL`.
 *    `check_invoice_changes_before_insert` es una función de trigger sin trigger.
 *
 * Escrita a mano con `migration:create`: `migration:generate` no puede producir esto
 * —al quitar la entity la tabla sale de su radar, y las funciones nunca estuvieron
 * en su modelo—.
 */
export class DropIntegrationLogs1757390000000 implements MigrationInterface {
	name = 'DropIntegrationLogs1757390000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// Primero las funciones: referencian la tabla en su cuerpo.
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.check_invoice_changes_before_insert()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.cleanup_duplicate_pending_invoice_lines(integer)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.cleanup_duplicate_pending_invoices(integer)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.cleanup_old_processed_invoices(integer, integer)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.integrate_invoices_to_legacy(uuid, uuid[], integer)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.rollback_invoice_integration(uuid)`);

		// Sin CASCADE a propósito: nada referencia la tabla, así que si algo apareciera
		// queremos que falle de forma visible en vez de arrastrarlo en silencio.
		// El DROP TABLE se lleva sus 2 policies, 7 índices y 3 FKs salientes.
		await queryRunner.query(`DROP TABLE IF EXISTS public.integration_logs`);
	}

	public async down(): Promise<void> {
		// Recrear la estructura vacía sería trivial, pero las 1378 filas no vuelven desde
		// una migración. Fingir reversibilidad sería peor que declararla irreversible.
		throw new Error(
			'DropIntegrationLogs es irreversible: la tabla y sus datos se restauran desde el backup de Supabase. ' +
				'El DDL original está en el historial de git (assets de functions/ y rls/ eliminados en este mismo cambio).'
		);
	}
}
