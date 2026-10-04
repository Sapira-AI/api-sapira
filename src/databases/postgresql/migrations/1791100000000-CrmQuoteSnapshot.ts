import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Cotizaciones del CRM protegidas (regla de Domi 03-10, `docs/v2-rediseno/contrato-api-integraciones.md` y
 * `cambios-integracion-para-leon.md` §14). Aditiva: el front actual no conoce estas columnas.
 *
 * - `salesforce_opportunities_stg.last_imported_snapshot` + `last_imported_at`: lo que llegó del CRM en la última importación a Sapira.
 *   Un cambio real del CRM es lo que llega ahora distinto de esto (no se compara contra la cotización: lo editado en Sapira se respeta).
 * - `salesforce_sync_runs.confirmed_by`: quién confirmó aplicar los cambios del CRM a cotizaciones existentes (solo por ids, nunca en la
 *   sincronización diaria ni con `all`). NULL = la ejecución solo crea.
 *
 * Entities: `entities/integraciones/salesforce/salesforce-opportunities-stg.entity.ts` y `salesforce-sync-run.entity.ts`.
 * Debe aplicarse antes de desplegar la API con cotizaciones protegidas. **NO APLICADA** al 03-10.
 */
export class CrmQuoteSnapshot1791100000000 implements MigrationInterface {
	name = 'CrmQuoteSnapshot1791100000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "salesforce_opportunities_stg" ADD "last_imported_snapshot" jsonb`);
		await queryRunner.query(
			`COMMENT ON COLUMN "salesforce_opportunities_stg"."last_imported_snapshot" IS 'Lo que llegó del CRM en la última importación a Sapira (encabezado mapeado + ítems). Base para detectar cambios reales del CRM'`
		);
		await queryRunner.query(`ALTER TABLE "salesforce_opportunities_stg" ADD "last_imported_at" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(
			`COMMENT ON COLUMN "salesforce_opportunities_stg"."last_imported_at" IS 'Cuándo se guardó last_imported_snapshot al crear o actualizar la cotización (NULL: base tomada al traer, sin importar)'`
		);
		await queryRunner.query(`ALTER TABLE "salesforce_sync_runs" ADD "confirmed_by" uuid`);
		await queryRunner.query(
			`COMMENT ON COLUMN "salesforce_sync_runs"."confirmed_by" IS 'Usuario (public.users.id) que confirmó actualizar cotizaciones existentes con los cambios del CRM. NULL: solo crea'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "salesforce_sync_runs" DROP COLUMN IF EXISTS "confirmed_by"`);
		await queryRunner.query(`ALTER TABLE "salesforce_opportunities_stg" DROP COLUMN IF EXISTS "last_imported_at"`);
		await queryRunner.query(`ALTER TABLE "salesforce_opportunities_stg" DROP COLUMN IF EXISTS "last_imported_snapshot"`);
	}
}
