import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Retira 62 funciones (64 firmas) de `public` sin ningún llamador conocido (04-10-2026, decisión de Domi).
 *
 * Fuente: catálogo `docs/v2-rediseno/catalogo-funciones-y-triggers.md`, lista 2.6 "Sin uso detectado" (70). El front viejo quedó
 * bloqueado el 04-10 y no hay vuelta atrás a él; 63 de las 64 firmas tienen EXECUTE para `anon` (50 de ellas SECURITY DEFINER) y
 * 21 escriben datos (17 directo, 4 a través de otra función): mantenerlas es más riesgoso que borrarlas. Las duplicadas que v2 no usa entran solo si además no tienen llamador.
 *
 * Verificación del 04-10 contra producción (solo lectura, `BEGIN TRANSACTION READ ONLY … ROLLBACK`) y en los tres repos:
 * - ninguna otra función las menciona en `prosrc` (todos los esquemas no de sistema), salvo otra de esta misma lista;
 * - ninguna es función de un trigger (`pg_trigger`), ni está en una policy (`pg_policy` qual/with_check), vista, default o check
 *   (`pg_depend`, `pg_views`, `pg_attrdef`), ni en `cron.job`;
 * - ninguna llamada en `api-sapira/src` (fuera de su asset y de comentarios), `sapira-ai/src`, `front-sapira` ni en las edge functions
 *   vigentes con fuente (check-overdue-invoices, send-proforma, send-collection).
 *
 * Quedaron fuera de la lista 2.6 (siguen en la base): `calculate_contract_fx_rate` (3 firmas) y `fx_rate_with_indirect` (bloque FX
 * sin commit: `fx-model.spec.ts` lee su asset), `revenue_schedule_update_period_quantities` (sus llamadores siguen en prod hasta
 * aplicar `1791300000000`), `trigger_generate_invoices_on_status_change` (`costura-sapira-writer.spec.ts` y el `down()` de
 * `1790660000000`), `get_effective_client_agent_config` (se queda para Automatizaciones: el front nuevo la anota como base de la
 * configuración de agentes por cliente) y el motor del devengo de suscripciones Stripe `rsm_rebuild_subscription`,
 * `rsm_rebuild_from_subscription` y `rsm_apply_fx_for_subscription` (se revisa con Stripe; decisión de Domi 04-10). Ninguna de las
 * que se borran llama a esas cuatro, ni ellas a una de las que se borran.
 *
 * Probado en la copia local (Postgres 15): los 64 DROP en una transacción sin error de dependencias; después,
 * `revenue_schedule_rebuild` de 3 contratos, alta/cambio/baja de una factura y sus líneas (rollback) y las policies de 133 tablas
 * leídas como `authenticated`.
 *
 * Una firma por sentencia, con `IF EXISTS` (QA puede no tener alguna) y sin `CASCADE`: si apareciera una dependencia que no vimos
 * (trigger, policy, vista), queremos que falle. Ojo: una llamada dentro del cuerpo plpgsql de otra función NO es dependencia para
 * Postgres; por eso la verificación de `prosrc` se hizo antes. Las que llaman a otra de la lista van antes que la llamada.
 *
 * Respaldo para restaurar (definición completa, dueño, comentario y permisos de producción):
 * `docs/v2-rediseno/archivo-funciones/2026-10-04-sin-uso.sql.txt`. Los assets `functions/*.sql` se borran en el mismo commit.
 */
export class RetiraFuncionesSinUso1791400000000 implements MigrationInterface {
	name = 'RetiraFuncionesSinUso1791400000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// Devengo/Revenue (9 funciones, 9 firmas): pantallas Revenue viejas; los dos *_on_override son funciones de trigger sin trigger.
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.admin_populate_revenue_schedule(p_holding_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.enable_and_populate_revenue_schedule()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.revenue_schedule_rebuild_for_invoice(p_invoice_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.revenue_schedule_get_monthly(p_contract_id uuid)`);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.revenue_consolidated_summary(p_from date, p_to date, p_granularity text, p_company_id uuid)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.revenue_consolidated_journal(p_from date, p_to date, p_granularity text, p_company_id uuid)`
		);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_current_mrr_by_holding(p_holding_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.trigger_update_schedule_on_override()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.update_revenue_schedule_period(p_contract_item_id uuid, p_period date)`);

		// FX (4 funciones, 4 firmas): duplicadas del tipo de cambio que v2 no usa (v2: calculate_system_fx_rate, contract_item_fx_rate, holding_fixed_fx_rate).
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.calculate_fx_suggestion(p_from_currency text, p_to_currency text, p_reference_date date)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.contract_fx_policy_upsert(p_contract_id uuid, p_company_fx_policy fx_policy_type, p_company_fx_fixed_rate numeric, p_company_fx_table_id uuid, p_system_fx_policy fx_policy_type, p_system_fx_fixed_rate numeric, p_system_fx_table_id uuid)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.convert_amount(p_holding_id uuid, p_amount numeric, p_from_currency text, p_to_currency text, p_reference_date date, p_policy text)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.get_fx_rate(p_holding_id uuid, p_from_currency text, p_to_currency text, p_reference_date date, p_policy text)`
		);

		// Contratos (8 funciones, 8 firmas): RPC y validadores del front viejo y del flujo legacy sin llamador.
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.auto_expire_contracts()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.generate_invoices_for_contract_item(p_item_id uuid, p_metadata jsonb)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.mark_contracts_as_bulk_import(contract_ids uuid[])`);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.search_contracts_by_client_identity(p_tax_id text, p_legal_name text, p_only_legacy boolean)`
		);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.suggest_contract_item_matches(p_invoice_item_legacy_id uuid, p_contract_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.validate_billing_splits_total(p_contract_id uuid, p_date date)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.validate_legacy_reconciliation(p_invoice_legacy_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.validate_mrr_legacy_splits(p_invoice_item_legacy_id uuid, p_period_month date)`);

		// Facturación (9 funciones, 9 firmas): trigger_update_invoices_on_override es función de trigger sin trigger; get_invoice_net_amount y get_invoice_items_with_credits quedaron huérfanas con DropVistasSinUso.
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.cancel_invoice_with_credit_note(p_invoice_id uuid, p_credit_note_data jsonb)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_consolidable_invoices_for_period(p_contract_id uuid, p_period date)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_invoice_items_with_credits(p_invoice_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_invoice_net_amount(p_invoice_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.recalculate_invoice_totals(p_invoice_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.send_proforma_safe(p_invoice_id uuid, p_recipient text, p_message text)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.trigger_update_invoices_on_override()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.update_pending_invoices_on_override(p_contract_item_id uuid, p_period_month date)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.is_date_closed(p_holding_id uuid, p_company_id uuid, p_date date)`);

		// Clientes y holding (10 funciones, 10 firmas): alta/edición de holdings con la anon key y validadores sin llamador.
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.duplicate_client_entity_for_multiple_clients(p_source_entity_id uuid, p_client_ids uuid[])`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.create_company_holding(p_name text, p_website text, p_phone text, p_email text, p_logo_url text)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.create_company_holding_direct(p_name text, p_website text, p_phone text, p_email text, p_logo_url text)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.update_company_holding_direct(p_id uuid, p_name text, p_website text, p_phone text, p_email text, p_logo_url text)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.create_user_holding_safe(p_user_id uuid, p_name text, p_website text, p_phone text, p_email text, p_logo_url text)`
		);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.check_user_has_holding()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.check_user_has_holding_direct(user_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.validate_user_has_holding()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_custom_field_definitions(p_entity_type text, p_holding_id uuid)`);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.validate_custom_fields(p_entity_type text, p_holding_id uuid, p_custom_fields jsonb)`
		);

		// Integraciones (6 funciones, 7 firmas): mapeo y staging de Odoo; la API replica resolve_field_transformation en field-transformation.service.ts.
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.apply_field_mapping_to_data(holding_id_param uuid, mapping_config jsonb, source_data jsonb, target_table text)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.apply_field_mapping_to_data(source_data jsonb, mapping_config jsonb, target_table text)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.resolve_field_transformation(p_transformation_type transformation_type_enum, p_transformation_config jsonb, p_source_value text, p_holding_id uuid)`
		);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.extract_mapped_fields_hierarchical(mapping_config jsonb, mapping_section text)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_invoice_staging_stats(holding_id_param uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_odoo_partners_stg_debug(limit_count integer)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.cleanup_duplicate_partners_by_vat(holding_id_param uuid, batch_size integer)`);

		// Notificaciones y agentes (3 funciones, 4 firmas): rag_match_documents y rsm_metrics eran de la edge rag-chat (retirada el 04-10).
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_default_email_sender(p_holding_id uuid)`);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.rag_match_documents(query_embedding vector, match_count integer, match_threshold double precision)`
		);
		await queryRunner.query(
			`DROP FUNCTION IF EXISTS public.rsm_metrics(date_from date, date_to date, metric text, currency_mode text, group_by text[], filters jsonb)`
		);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.rsm_metrics(params jsonb)`);

		// Tenancy y pruebas (13 funciones, 13 firmas): variantes duplicadas del holding de sesión y funciones de depuración; ninguna está en una policy.
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_user_holding_id_robust()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_user_holding_id_safe()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_user_holding_data_direct(user_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_user_holding_data_robust()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_current_user_role()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.debug_current_user_context()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.debug_user_access()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.rls_can_see_user_debug(target_user_id uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.test_can_see_users()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.test_rls_access()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.test_rls_access_v2()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.test_user_access()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.bootstrap_accounting_period_cutoffs()`);
	}

	public async down(): Promise<void> {
		throw new Error(
			'RetiraFuncionesSinUso no es reversible por migración: las 64 firmas retiradas no deben volver. ' +
				'Si hiciera falta una, restaurar su bloque desde docs/v2-rediseno/archivo-funciones/2026-10-04-sin-uso.sql.txt ' +
				'(ejecutarlo como postgres) y devolver su asset desde git a src/databases/postgresql/functions/.'
		);
	}
}
