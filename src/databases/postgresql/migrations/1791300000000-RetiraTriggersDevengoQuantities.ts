import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retiro de los triggers del front viejo que escribían el devengo (`revenue_schedule_monthly`) al registrar o borrar un
 * override de cantidades en `public.quantities` (04-10-2026, orden de Domi: se van a corregir datos y la lógica que ya no se
 * usa no debe pisar las correcciones). Regla: `docs/reglas-desarrollo/logica-en-api-triggers.md` § Retiro.
 *
 * - `trg_rsm_on_quantity_change` (AFTER INSERT OR UPDATE → `trigger_rsm_on_quantity_change()`): escribía el mes del override
 *   con `revenue_schedule_update_period_quantities` (sin descuento, `COALESCE(amount, unitario × cantidad)`). Ya era no-op con
 *   `sapira.writer = 'api'`; corría para el front viejo y para el sync del DWH (sin la marca).
 * - `trg_restore_rsm_on_quantity_delete` (AFTER DELETE → `restore_rsm_on_quantity_delete()`): al borrar un override devolvía
 *   el mes al monto del ítem. Leía `financial_settings` del holding de la sesión (`get_current_user_holding_id()`), así que
 *   sin sesión (API, DWH, cron) ya no hacía nada; corría solo para el front viejo.
 *
 * Quién recalcula ahora: la API, explícito, con `revenue_schedule_rebuild(contrato, mes)`, que devenga el override del período
 * con la regla de la factura (D2, `functions/revenue_schedule_rebuild_contract_ccy.sql`): consumos v2 (`consumption.service.ts`)
 * y el sync del DWH (`bigquery.service.ts`: `integrateSapiraQuantities` y `replaceQuantityRecord`). **Orden**: el asset de
 * `revenue_schedule_rebuild_contract_ccy` con D2 va antes que esta migración, o el rebuild del DWH no devengaría el override.
 * El front viejo deja de actualizar el devengo al editar cantidades (aceptado: se corrige con un rebuild del contrato).
 *
 * Se conservan los otros 4 triggers de `quantities` (`trg_quantities_set_holding`, `trg_validate_quantity_invoice_status`,
 * `trg_sync_invoice_items_from_quantities`, `trg_restore_invoice_items_on_quantity_delete`): ninguno escribe devengo (los dos
 * de sincronización solo tocan facturas Por Emitir, que `trigger_rsm_on_invoice_change` ignora).
 *
 * Primero los triggers, después sus funciones. Sin `CASCADE`: si apareciera otra dependencia, que falle. `IF EXISTS` por si un
 * entorno no los tiene. `revenue_schedule_update_period_quantities` queda sin llamadores (solo la usaban estas dos funciones):
 * se retira aparte, con su doble confirmación.
 *
 * `down()` no recrea nada: es lógica que no debe volver. Si hiciera falta, se restauran los cuatro assets desde git (commit de
 * esta migración) y se aplican con `yarn postgres:assets --apply --only <ruta>` (funciones antes que triggers).
 */
export class RetiraTriggersDevengoQuantities1791300000000 implements MigrationInterface {
	name = 'RetiraTriggersDevengoQuantities1791300000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TRIGGER IF EXISTS trg_rsm_on_quantity_change ON public.quantities`);
		await queryRunner.query(`DROP TRIGGER IF EXISTS trg_restore_rsm_on_quantity_delete ON public.quantities`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.trigger_rsm_on_quantity_change()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.restore_rsm_on_quantity_delete()`);
	}

	public async down(): Promise<void> {
		throw new Error(
			'RetiraTriggersDevengoQuantities no es reversible por migración: los triggers de devengo sobre quantities no deben volver. ' +
				'Si hiciera falta, restaurar desde git (commit de esta migración) functions/trigger_rsm_on_quantity_change.sql, ' +
				'functions/restore_rsm_on_quantity_delete.sql y sus triggers/, y aplicarlos con `yarn postgres:assets --apply --only <ruta>` ' +
				'(funciones antes que triggers).'
		);
	}
}
