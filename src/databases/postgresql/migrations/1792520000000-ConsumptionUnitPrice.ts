import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Precio unitario del período en el consumo (Ransa/SimpliRoute, Domi 13-11; `docs/cambios/precio-unitario-del-periodo-13-11.md`).
 *
 * - `consumption_entries.unit_price`: unitario informado junto con la cantidad en un ítem de precio estándar por consumo (cantidad ×
 *   precio). La línea del período queda en `quantity × unit_price`; NULL = el unitario del precio del ítem, como hasta hoy. Es el
 *   unitario que tenía `quantities` en el front anterior y que la copia `1791600000000-ConsumosDesdeQuantities` convirtió a monto final
 *   (`amount_override`, retirado el 12-10): acá vuelve como columna propia, exacta (6 decimales).
 * - `consumption_entry_revisions.unit_price`: el mismo valor en el historial de cada revisión.
 *
 * Solo esquema: las filas existentes quedan en NULL (ningún consumo cambia). ⚠️ Orden de despliegue: correr esta migración ANTES de
 * desplegar el código que lee y escribe la columna.
 */
export class ConsumptionUnitPrice1792520000000 implements MigrationInterface {
	name = 'ConsumptionUnitPrice1792520000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "public"."consumption_entries" ADD COLUMN IF NOT EXISTS "unit_price" numeric(18,6)`);
		await queryRunner.query(
			`COMMENT ON COLUMN "public"."consumption_entries"."unit_price" IS 'Precio unitario informado para el período (moneda del ítem, antes del descuento): solo en precio estándar por consumo; la línea queda en quantity × unit_price. NULL = el unitario del precio del ítem'`
		);
		await queryRunner.query(`ALTER TABLE "public"."consumption_entries" DROP CONSTRAINT IF EXISTS "consumption_entries_unit_price_check"`);
		await queryRunner.query(
			`ALTER TABLE "public"."consumption_entries" ADD CONSTRAINT "consumption_entries_unit_price_check" CHECK ("unit_price" IS NULL OR "unit_price" >= 0)`
		);
		await queryRunner.query(`ALTER TABLE "public"."consumption_entry_revisions" ADD COLUMN IF NOT EXISTS "unit_price" numeric(18,6)`);
		await queryRunner.query(
			`COMMENT ON COLUMN "public"."consumption_entry_revisions"."unit_price" IS 'Precio unitario del período que valía en esta revisión (NULL = el del precio del ítem)'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "public"."consumption_entry_revisions" DROP COLUMN IF EXISTS "unit_price"`);
		await queryRunner.query(`ALTER TABLE "public"."consumption_entries" DROP CONSTRAINT IF EXISTS "consumption_entries_unit_price_check"`);
		await queryRunner.query(`ALTER TABLE "public"."consumption_entries" DROP COLUMN IF EXISTS "unit_price"`);
	}
}
