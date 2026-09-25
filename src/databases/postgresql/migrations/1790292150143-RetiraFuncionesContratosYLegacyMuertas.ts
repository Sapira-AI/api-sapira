import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bloque de saneamiento de Contratos (24-09-2026, Domi): retira 14 firmas de funciones sin uso.
 * Auditoría: `docs/v2-rediseno/auditoria-contratos.md` §2 (9 a retirar) y §7 S8 (7 legacy muertas o rotas).
 * Registro del saneamiento: `docs/v2-rediseno/saneamiento-contratos.md`.
 *
 * Doble confirmación de no-uso, hecha el 24-09 en producción (solo lectura) y en los tres repos:
 *
 * 1. **Código**: ningún llamador alcanzable. En el front viejo (`sapira-ai`) los únicos llamadores son
 *    componentes sin montar (`ContractActivationPanel`, `ContractLegacyAnalysisPanel`,
 *    `LegacyInvoiceReconciliationTable`, `WorkflowDashboard`, `ContratosGlobalReconciliation`,
 *    `DownSellingModal` comentado desde 28-05) o mutaciones de `useContractAmendments` que ningún
 *    componente usa (`createUpsell`, `createDownsell`, `createChurn`, `registerNonRenewal`,
 *    `createAmendmentWithInvoices`); ese código se borra en el mismo bloque. Cero referencias en
 *    `api-sapira` (fuera de su propio asset y un comentario en `apply_contract_contraction`) y en
 *    `front-sapira`. Ninguna está atada a un trigger ni agendada en `cron.job`. La única función que
 *    llama a otra de la lista es `activate_legacy_contract` → `validate_legacy_activation` (ambas salen).
 * 2. **Uso real**: logs del gateway de Supabase (`/rest/v1/rpc/<nombre>`) del 25-08 al 24-09, los 30
 *    días con datos: **0 llamadas** a las 14 firmas. `create_contract_renewal` sí tuvo 11 llamadas,
 *    pero de la **v2** (`p_term_months`), la única firma que usan el front viejo y el cron de
 *    auto-renovación; esa se queda.
 *
 * Por decisión de Domi no hay ventana de observación con REVOKE: el front viejo se reemplaza en
 * semanas y la doble confirmación cubre el riesgo.
 *
 * `create_contract_renewal` v1 nunca funcionó (castea `'renewal'` a un enum que solo tiene `RENEWAL`).
 * Se borra por firma exacta para no tocar la v2.
 *
 * Todas llevan `IF EXISTS`: QA puede no tener alguna sobrecarga. Sin `CASCADE`: si apareciera una
 * dependencia que no vimos, queremos que falle.
 *
 * `down()` no recrea las funciones: son ~2.500 líneas de SQL que no deben volver. Si hiciera falta,
 * se restauran desde git (los assets se borran en el mismo commit que esta migración) con
 * `yarn postgres:assets --apply --only functions/<archivo>.sql`.
 */
export class RetiraFuncionesContratosYLegacyMuertas1790292150143 implements MigrationInterface {
	name = 'RetiraFuncionesContratosYLegacyMuertas1790292150143';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// Contratos · movimientos comerciales (auditoría §2a)
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.create_contract_renewal(p_contract_id uuid, p_effective_date date, p_items jsonb, p_reason text, p_metadata jsonb, p_approval_required boolean)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.create_contract_upsell(p_contract_id uuid, p_items jsonb, p_effective_date date, p_reason text, p_metadata jsonb, p_approval_required boolean)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.create_contract_downsell(p_contract_id uuid, p_effective_date date, p_items jsonb, p_scope text, p_reason text, p_metadata jsonb, p_approval_required boolean)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.create_contract_churn(p_contract_id uuid, p_effective_date date, p_reason text, p_risk_level text, p_retention_action text, p_notes text)`
		);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.register_item_non_renewal(p_contract_id uuid, p_item_ids uuid[], p_reason text)`);

		// Contratos · estado, flujo y consultas (auditoría §2b, §2c)
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.migrate_contracts_to_new_workflow()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_contract_reconciliation(p_contract_id uuid)`);

		// Legacy muertas o rotas (auditoría §7 S8a). activate_legacy_contract va antes que validate_legacy_activation, que es llamada por ella.
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.activate_legacy_contract(p_contract_id uuid, p_options jsonb)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.validate_legacy_activation(p_contract_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.derive_contract_items_from_legacy(p_contract_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.confirm_legacy_invoice_reconciliation(p_invoice_legacy_id uuid)`);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.confirm_legacy_invoice_reconciliation(p_invoice_legacy_id uuid, p_force_rereconcile boolean)`
		);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.bulk_reconcile_legacy_invoices(p_contract_id uuid)`);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.bulk_reconcile_legacy_invoices(p_invoice_ids uuid[], p_contract_id uuid, p_user_id uuid)`
		);
	}

	public async down(): Promise<void> {
		throw new Error(
			'RetiraFuncionesContratosYLegacyMuertas no es reversible por migración: las 14 funciones retiradas no deben volver. ' +
				'Si hiciera falta una, restaurar su asset desde git (commit de esta migración, carpeta functions/) y aplicarlo con ' +
				'`yarn postgres:assets --apply --only functions/<archivo>.sql`.'
		);
	}
}
