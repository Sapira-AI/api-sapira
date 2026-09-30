import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Costura `sapira.writer = 'api'` (30-09-2026, Domi; `docs/v2-rediseno/activacion-costura-triggers.md`, decisión #9 del plan de
 * coexistencia): unifica los dos triggers legacy que generaban facturas al activar un contrato.
 *
 * - `generate_invoices_on_contract_active` (AFTER UPDATE OF status → `trigger_generate_invoices_on_status_change`) y
 *   `unified_generate_invoices_on_contract_signed` (AFTER INSERT OR UPDATE OF status → `trigger_generate_invoices_on_contract_signed`)
 *   hacían lo mismo: al pasar a Activo corrían los dos y el segundo se saltaba porque el primero ya había creado las facturas.
 *   El unificado cubre todos los casos del otro (INSERT, Firmado y Activo), así que queda solo él.
 * - Su función pasa a `SECURITY DEFINER` en el asset (`functions/trigger_generate_invoices_on_contract_signed.sql`) para
 *   seguir llamando a `generate_missing_invoices_for_contract` cuando `grants/030` le quite el EXECUTE a `authenticated`.
 *   **Orden**: ese asset va antes que el grant; esta migración puede ir antes o después (el unificado ya genera).
 *
 * Es una migración y no un `DROP` dentro del asset del trigger: eliminar un objeto es una transición (CLAUDE.md, "Migración o
 * asset"), y un `DROP` de otro trigger dentro de `triggers/unified_…sql` haría que `schema:status` lo viera distinto para siempre.
 * El asset `triggers/generate_invoices_on_contract_active.sql` se borra en el mismo commit. La función
 * `trigger_generate_invoices_on_status_change` queda sin trigger (con la costura) hasta su `DROP FUNCTION` en la baja.
 *
 * `down()` recrea el trigger con su definición de producción (`pg_get_triggerdef`, QA 30-09).
 */
export class UnificaTriggerGeneracionFacturas1790660000000 implements MigrationInterface {
	name = 'UnificaTriggerGeneracionFacturas1790660000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP TRIGGER IF EXISTS generate_invoices_on_contract_active ON public.contracts`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TRIGGER generate_invoices_on_contract_active AFTER UPDATE OF status ON public.contracts FOR EACH ROW EXECUTE FUNCTION trigger_generate_invoices_on_status_change()`
		);
	}
}
