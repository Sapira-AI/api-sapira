import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Activa RLS en las 8 tablas de `public` que no lo tenían.
 *
 * Producción tiene 123 de 131 tablas con RLS; estas 8 eran las únicas sin ninguna capa de
 * contención, porque `grants/000-table-privileges.sql` concede `ALL PRIVILEGES` a `anon` sobre
 * todas las tablas —el modelo del esquema asume explícitamente que la contención la hace RLS, no
 * el GRANT—. Medido con la anon key el 2026-09-14, las 8 devolvían filas por PostgREST.
 *
 * Dos de ellas son del propio tooling: `sapira_sql_asset_history` y `sapira_typeorm_migrations`
 * tenían `INSERT/UPDATE/DELETE/TRUNCATE` abiertos a `anon`. No es pérdida de datos de negocio: es
 * pérdida del **registro con el que se decide qué aplicar**.
 *
 * **Seis quedan deny-all a propósito** (`odoo_product_mappings`, `stripe_product_mappings`,
 * `stripe_sync_jobs`, `client_entity_tax_id_normalization_conflicts` y las dos del tooling): ninguna
 * tiene consumidor `supabase-js` —verificado con grep de `.from()` y `rpc` en todo
 * `front-sapira-vite/src`—, y su único lector es el backend, que se conecta con el rol `postgres`,
 * que tiene `rolbypassrls`. Desde deny-all solo se puede ampliar, y ampliar es un asset aditivo de
 * riesgo cero; desde `RLS off + GRANT ALL a anon` no se llega a ningún lado seguro.
 *
 * Las otras dos son catálogos globales y sí llevan policy de lectura, aplicadas ANTES que esta
 * migración para que no hubiera un instante de deny-all:
 * `rls/generic_export_vats_select_active.sql` y `rls/indicadores_economicos_select.sql`.
 *
 * **Por qué esto no puede romper el backend**, y es medición y no suposición: el rol de la conexión
 * es `postgres` con `rolbypassrls = true`, y ya convive con `FORCE ROW LEVEL SECURITY` en `invoices`,
 * `products` y `workflow_step_documents` —`FORCE` somete incluso al dueño de la tabla a sus propias
 * policies—. El backend lee `invoices` continuamente y funciona.
 *
 * Verificado antes de aplicar con `yarn schema:verify-policies --target production`, que simula la
 * identidad de dos usuarios reales de holdings distintos dentro de una transacción de solo lectura:
 * el usuario A ve exactamente las filas de su holding, el B ve 0 de las del A, y `anon` sin claims
 * ve 0.
 *
 * ⚠️ El `down()` restaura un estado **inseguro**: deja las 8 tablas legibles y escribibles con la
 * anon key. Existe para poder revertir rápido durante la ventana de observación, no porque ese
 * estado sea aceptable.
 */
export class HabilitaRlsEnTablasSinContencion1789041000000 implements MigrationInterface {
	name = 'HabilitaRlsEnTablasSinContencion1789041000000';

	private static readonly TABLAS = [
		'client_entity_tax_id_normalization_conflicts',
		'generic_export_vats',
		'indicadores_economicos',
		'odoo_product_mappings',
		'sapira_sql_asset_history',
		'sapira_typeorm_migrations',
		'stripe_product_mappings',
		'stripe_sync_jobs',
	];

	public async up(queryRunner: QueryRunner): Promise<void> {
		for (const tabla of HabilitaRlsEnTablasSinContencion1789041000000.TABLAS) {
			await queryRunner.query(`ALTER TABLE "public"."${tabla}" ENABLE ROW LEVEL SECURITY`);
		}
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		for (const tabla of [...HabilitaRlsEnTablasSinContencion1789041000000.TABLAS].reverse()) {
			await queryRunner.query(`ALTER TABLE "public"."${tabla}" DISABLE ROW LEVEL SECURITY`);
		}
	}
}
