import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Condiciones de pago por defecto de una razón social (roadmap operativo #11).
 *
 * Hoy los términos son texto libre y el generador de facturas usa `emisión + 30 días` para todo: en
 * agosto 2026 el SAT rechazó 13 facturas PPD de TiMining porque exigen vencimiento el mes siguiente.
 *
 * Dónde vive (decidido por Domi, 22-09-2026): en `client_entities`, no en el vínculo
 * `client_entity_clients`. Es el default de la razón social; la factura y el contrato copian la regla y
 * pueden sobrescribirla cuando haga falta, así que la flexibilidad queda en el documento.
 *
 * Forma (la misma de `front-sapira` `_lib/payment-terms.ts`):
 * - `{"kind":"net","days":30}`: N días desde la emisión (0 = contado)
 * - `{"kind":"end_of_month","days":30}`: fin del mes de emisión + N días
 * - `{"kind":"day_of_next_month","day":17}`: día fijo del mes siguiente (SAT PPD); si el mes es más
 *   corto, el último día
 * NULL = sin condición propia (el generador sigue con su default).
 *
 * El CHECK usa CASE anidados para no castear antes de validar el tipo (Postgres no garantiza el orden
 * de evaluación de AND/OR).
 *
 * ⚠️ Orden de despliegue: correr esta migración ANTES de desplegar el código que declara la columna
 * en `ClientEntity`. Al revés, TypeORM seleccionaría una columna inexistente en cada lectura de la tabla.
 */
export class AddClientEntityPaymentTerms1789200000000 implements MigrationInterface {
	name = 'AddClientEntityPaymentTerms1789200000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "public"."client_entities" ADD COLUMN IF NOT EXISTS "payment_terms" jsonb`);
		await queryRunner.query(
			`ALTER TABLE "public"."client_entities" ADD CONSTRAINT "client_entities_payment_terms_check" CHECK (
				payment_terms IS NULL OR CASE payment_terms->>'kind'
					WHEN 'net' THEN CASE WHEN jsonb_typeof(payment_terms->'days') = 'number' THEN (payment_terms->>'days')::numeric BETWEEN 0 AND 365 ELSE false END
					WHEN 'end_of_month' THEN CASE WHEN jsonb_typeof(payment_terms->'days') = 'number' THEN (payment_terms->>'days')::numeric BETWEEN 0 AND 365 ELSE false END
					WHEN 'day_of_next_month' THEN CASE WHEN jsonb_typeof(payment_terms->'day') = 'number' THEN (payment_terms->>'day')::numeric BETWEEN 1 AND 31 ELSE false END
					ELSE false
				END
			)`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "public"."client_entities"."payment_terms" IS 'Condición de pago por defecto: {kind: net|end_of_month, days} o {kind: day_of_next_month, day}. NULL = sin condición propia'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "public"."client_entities" DROP CONSTRAINT IF EXISTS "client_entities_payment_terms_check"`);
		await queryRunner.query(`ALTER TABLE "public"."client_entities" DROP COLUMN IF EXISTS "payment_terms"`);
	}
}
