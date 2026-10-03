import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Conciliación bancaria v2 (`docs/v2-rediseno/spec-conciliacion-v2.md` §2.1, decisiones de Domi 02-10-2026). Escrita, **NO aplicada**.
 *
 * 1. `bank_movements.status` admite `Ignorado` ("No es una factura"); filas existentes intactas (`Pendiente`/`Conciliado`).
 * 2. `bank_movements.ignore_reason` (texto, NULL): motivo de Ignorar; quién/cuándo van en `reconciled_by/reconciled_at`.
 * 3. Índice único parcial de huella por línea `uq_bank_movements_fingerprint` (holding + `original_row_data->>'fingerprint'`): las filas
 *    viejas no tienen huella y quedan fuera. También es asset (`special-index/uq_bank_movements_fingerprint.sql`, `IF NOT EXISTS`).
 * 4. `invoice_payments.original_amount` + `fx_rate` (pago en moneda distinta a la del movimiento): `amount`/`currency` = moneda de la
 *    factura; `original_amount` en la moneda del movimiento (`bank_movements.currency` vía `bank_movement_id`); CHECK
 *    `invoice_payments_original_check` (ambos o ninguno, y solo con `bank_movement_id`).
 * 5. `invoice_payments.settlement_reason` (ajuste no monetario: comisión, retención, diferencia de cambio, redondeo, otro) con CHECK
 *    `invoice_payments_settlement_reason_check`. NULL = pago monetario (todas las filas existentes).
 *
 * `down`: los `Ignorado` vuelven a `Pendiente` (con `ignore_reason` anulado) antes de restituir el CHECK viejo; luego suelta índice,
 * CHECKs y columnas.
 */
export class BankReconciliationV21790740000000 implements MigrationInterface {
	name = 'BankReconciliationV21790740000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "bank_movements" DROP CONSTRAINT IF EXISTS "bank_movements_status_check"`);
		await queryRunner.query(
			`ALTER TABLE "bank_movements" ADD CONSTRAINT "bank_movements_status_check" CHECK (status = ANY (ARRAY['Pendiente'::text, 'Conciliado'::text, 'Ignorado'::text]))`
		);
		await queryRunner.query(`ALTER TABLE "bank_movements" ADD COLUMN IF NOT EXISTS "ignore_reason" text NULL`);
		await queryRunner.query(
			`CREATE UNIQUE INDEX IF NOT EXISTS "uq_bank_movements_fingerprint" ON public.bank_movements USING btree (holding_id, ((original_row_data ->> 'fingerprint'))) WHERE ((original_row_data ->> 'fingerprint') IS NOT NULL)`
		);
		await queryRunner.query(
			`ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "original_amount" numeric NULL, ADD COLUMN IF NOT EXISTS "fx_rate" numeric NULL`
		);
		await queryRunner.query(
			`ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_original_check" CHECK (((original_amount IS NULL) = (fx_rate IS NULL)) AND ((original_amount IS NULL) OR (bank_movement_id IS NOT NULL)))`
		);
		await queryRunner.query(`ALTER TABLE "invoice_payments" ADD COLUMN IF NOT EXISTS "settlement_reason" text NULL`);
		await queryRunner.query(
			`ALTER TABLE "invoice_payments" ADD CONSTRAINT "invoice_payments_settlement_reason_check" CHECK ((settlement_reason IS NULL) OR (settlement_reason = ANY (ARRAY['bank_fee'::text, 'withholding'::text, 'fx_difference'::text, 'rounding'::text, 'other'::text])))`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`UPDATE "bank_movements" SET status = 'Pendiente', ignore_reason = NULL WHERE status = 'Ignorado'`);
		await queryRunner.query(`ALTER TABLE "bank_movements" DROP CONSTRAINT IF EXISTS "bank_movements_status_check"`);
		await queryRunner.query(
			`ALTER TABLE "bank_movements" ADD CONSTRAINT "bank_movements_status_check" CHECK (status = ANY (ARRAY['Pendiente'::text, 'Conciliado'::text]))`
		);
		await queryRunner.query(`DROP INDEX IF EXISTS "uq_bank_movements_fingerprint"`);
		await queryRunner.query(`ALTER TABLE "bank_movements" DROP COLUMN IF EXISTS "ignore_reason"`);
		await queryRunner.query(`ALTER TABLE "invoice_payments" DROP CONSTRAINT IF EXISTS "invoice_payments_settlement_reason_check"`);
		await queryRunner.query(`ALTER TABLE "invoice_payments" DROP CONSTRAINT IF EXISTS "invoice_payments_original_check"`);
		await queryRunner.query(`ALTER TABLE "invoice_payments" DROP COLUMN IF EXISTS "settlement_reason"`);
		await queryRunner.query(`ALTER TABLE "invoice_payments" DROP COLUMN IF EXISTS "fx_rate"`);
		await queryRunner.query(`ALTER TABLE "invoice_payments" DROP COLUMN IF EXISTS "original_amount"`);
	}
}
