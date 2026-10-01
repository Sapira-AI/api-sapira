import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Saneamiento del dominio Odoo (27-09-2026, Leon), paso 0 de su migración al front nuevo:
 * retira 19 firmas de funciones sin uso. Inventario: `docs/v2-rediseno/inventario-integracion-odoo.md`.
 *
 * **Por qué están muertas**: el pipeline de partners ya no vive en Postgres, vive en TypeScript
 * (`modules/odoo/services/partners-processor.service.ts`). Las funciones que lo implementaban quedaron
 * huérfanas, y varias están rotas por construcción:
 *
 * - `process_partner_staging_to_client_entities` y `process_partner_staging_with_transformations` filtran
 *   por `processing_status = 'pending'`, un estado que el CHECK de `odoo_partners_stg` no admite
 *   (`create | update | processed | error`): recorren cero filas siempre. Ya estaba registrado en
 *   `src/databases/postgresql/README.md`.
 * - La primera, además, invoca `apply_field_mapping_to_data(jsonb, jsonb, text, uuid)` cuando la firma
 *   declarada es `(uuid, jsonb, jsonb, text)` → `42883` garantizado.
 * - `process_partner_staging_with_transformations` recibe `staging_ids uuid[]` contra un PK `bigint`.
 * - `migrate_existing_partners_to_new_system` es un cascarón: su loop solo incrementa un contador.
 * - `classify_invoice_before_insert` no tiene trigger asociado (se borró de prod en feb-2026) y llama a
 *   `detect_invoice_changes_with_dynamic_mapping`, que no tiene asset en el repo.
 * - `update_odoo_invoices_staging_updated_at` no la usa ningún trigger: el de `odoo_invoices_stg` usa
 *   `update_invoice_timestamp()`.
 * - Las tres variantes de `detect_partner_changes*` son copias entre sí y ninguna tiene caller.
 *
 * **Doble confirmación de no-uso (27-09), como exige `RetiraFuncionesContratosYLegacyMuertas`:**
 *
 * 1. **Código**: cero llamadas alcanzables en los tres repos — ni en `api-sapira` (fuera de dos
 *    comentarios: el JSDoc de `field-transformation.service.ts` y el de la migración
 *    `AlignStagingProcessingStatusDefault`), ni en `front-sapira-vite` por `supabase.rpc()` ni en sus
 *    Edge Functions, ni en `front-sapira`. Ninguna está atada a un trigger ni agendada en `cron.job`.
 * 2. **Uso real**: `pg_stat_statements` de producción, ventana desde el **2025-05-06** (~17 meses),
 *    `track = top` (o sea, llamadas de cliente, no anidadas). Las 19 firmas de abajo **no aparecen**.
 *
 * ⚠️ **Cuatro funciones salieron de la lista porque SÍ tienen llamadas por PostgREST** y se quedan:
 * `apply_field_mapping_to_data` (46.147 entre sus dos sobrecargas), `get_invoice_staging_stats` (136),
 * `get_odoo_partners_stg_debug` (11) y `resolve_field_transformation` (sin llamadas propias, pero
 * **la invoca `apply_field_mapping_to_data`**: retirarla habría roto una función con 46 mil llamadas).
 * `pg_stat_statements` v1.10 no guarda la fecha de la última llamada, así que no se puede fechar ese
 * tráfico; queda pendiente decidir si se retiran con una ventana de observación por `REVOKE`, como se
 * hizo con `cleanup_duplicate_partners_by_vat`.
 *
 * Límite de la evidencia: la tabla está en su tope (4.959 de 5.000 entradas), así que evicta por uso.
 * La ausencia de una firma es evidencia fuerte, no prueba absoluta.
 *
 * Las tres funciones del dominio que el front viejo SÍ usa (`get_table_columns`,
 * `cleanup_old_processed_records`, `reset_invoice_odoo_draft`) nunca estuvieron en la lista.
 *
 * Todas llevan `IF EXISTS`: QA puede no tener alguna sobrecarga. Sin `CASCADE`: si apareciera una
 * dependencia que no vimos, queremos que falle y no que se lleve un trigger por delante.
 *
 * ## Cómo volver atrás una función (probado en QA el 01-10-2026)
 *
 * `down()` no recrea nada: este `revert` falla a propósito. La recuperación es por función, y toma un
 * minuto. **Ojo con el paso 2**: sin él el runner responde `OMITIDO`, porque el historial de assets
 * todavía tiene el checksum registrado aunque la función ya no exista en la base.
 *
 * ```bash
 * # 1. Recuperar el asset desde git (se borran en el mismo commit que esta migración)
 * git show <commit>^:src/databases/postgresql/functions/<archivo>.sql > src/databases/postgresql/functions/<archivo>.sql
 *
 * # 2. Hacer que el runner lo "olvide", o lo salta
 * #    DELETE FROM public.sapira_sql_asset_history WHERE asset_path = 'functions/<archivo>.sql';
 *
 * # 3. Re-aplicar solo esa función
 * DOTENV_CONFIG_PATH=.env.prod.db yarn postgres:assets --apply --only functions/<archivo>.sql \
 *   --target production --allow-production --confirm-target production
 * ```
 *
 * Ninguna de las 19 tiene objetos dependientes (verificado en prod con `pg_depend`), y no se borra
 * ningún dato: el peor caso de un `DROP` equivocado es un `42883` ruidoso en el cliente, no pérdida.
 */
export class RetiraFuncionesOdooMuertas1790500000000 implements MigrationInterface {
	name = 'RetiraFuncionesOdooMuertas1790500000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// Pipeline de partners reemplazado por TypeScript
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.process_partner_staging_to_client_entities(uuid, text)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.process_partner_staging_with_transformations(uuid[], uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.apply_partner_mapping_with_transformations(jsonb, jsonb, uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.migrate_existing_partners_to_new_system(uuid)`);

		// Detección de cambios: tres copias de lo mismo, ninguna con caller
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.detect_partner_changes(jsonb, jsonb, uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.detect_partner_changes(jsonb, jsonb, text[])`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.detect_partner_changes_with_mapping(jsonb, jsonb, uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.detect_invoice_changes(jsonb, jsonb, text[])`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.detect_invoice_line_changes(jsonb, jsonb, text[])`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.detect_invoice_line_changes_with_dynamic_mapping(jsonb, uuid, uuid)`);

		// Clasificación de facturas: su trigger se borró de prod en feb-2026
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.classify_invoice_before_insert()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.update_odoo_invoices_staging_updated_at()`);

		// Estadística y verificación, reemplazadas por los servicios de la API
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_invoice_integration_stats(uuid, uuid)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.verify_invoice_staging_integrity()`);

		// Mapeo y transformación de campos, reimplementados en TypeScript
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.apply_field_transformations_from_frontend(jsonb, uuid, text, text)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_available_transformation_types()`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.get_hierarchical_mapping(uuid, text, text)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.validate_hierarchical_mapping(jsonb)`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS public.verify_hierarchical_mapping_extension()`);
	}

	public async down(): Promise<void> {
		throw new Error(
			'RetiraFuncionesOdooMuertas no es reversible por migración: las 19 firmas retiradas no deben volver. ' +
				'Si hiciera falta una, restaurar su asset desde git (commit de esta migración, carpeta functions/) y aplicarlo con ' +
				'`yarn postgres:assets --apply --only functions/<archivo>.sql`.'
		);
	}
}
