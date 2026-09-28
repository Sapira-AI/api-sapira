import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Contratos v2 · esquema aditivo para crear contratos (C1) y borrarlos lógicamente (C5).
 * Mapa: `docs/v2-rediseno/mapa-v2-contratos.md` §6; decisiones S1-4, S1-7, S3-16 y S2-9 de
 * `docs/v2-rediseno/auditoria-contratos.md`.
 *
 * - `billing_anchor_day` (smallint, 1–31): día de ciclo explícito. Hoy se deriva en dos copias (front y RSM) del día de
 *   `MIN(start_date)` de los recurrentes; v2 lo guarda al crear. NULL en los contratos existentes (sin backfill aquí:
 *   el backfill es una transformación de datos aparte, con OK).
 * - `payment_terms` (jsonb): misma forma y mismo CHECK que `client_entities.payment_terms`
 *   (`1789200000000-AddClientEntityPaymentTerms`). Default al crear = la de la razón social.
 * - `document_type` (text): `FACTURA` | `FACTURA_EXPORTACION`, alineado con `invoices_document_type_check` (sin NC/ND,
 *   que no nacen del contrato, ni el valor heredado `Invoice`). De él se deriva `invoices.export_type`.
 * - `deleted_at` (timestamptz): borrado lógico de borradores. Las lecturas v2 filtran `deleted_at IS NULL`.
 *
 * Generada con `migration:generate` contra QA (25-09-2026) y recortada a solo este cambio: el resto de la salida era la
 * deriva conocida (FKs/defaults que netean a cero y lo propio de QA en Salesforce).
 *
 * Todas las columnas son NULL y sin default: no reescribe la tabla y el front viejo no se entera.
 *
 * ⚠️ Orden de despliegue: aplicar esta migración ANTES de desplegar el código que declara las columnas en `Contract`
 * (TypeORM las seleccionaría) y que filtra `contracts.deleted_at` en las lecturas de `ContractsService`.
 */
export class AddContractBillingFields1790358766159 implements MigrationInterface {
	name = 'AddContractBillingFields1790358766159';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "contracts" ADD "billing_anchor_day" smallint`);
		await queryRunner.query(
			`COMMENT ON COLUMN "contracts"."billing_anchor_day" IS 'Día de ciclo de facturación (1-31): los períodos parten ese día de cada mes (el último día si el mes es más corto). NULL = contratos anteriores a v2: se deriva del día del MIN(start_date) de los ítems recurrentes'`
		);
		await queryRunner.query(`ALTER TABLE "contracts" ADD "payment_terms" jsonb`);
		await queryRunner.query(
			`COMMENT ON COLUMN "contracts"."payment_terms" IS 'Condición de pago del contrato (misma forma que client_entities.payment_terms): {kind: net|end_of_month, days} o {kind: day_of_next_month, day}. Default al crear: la de la razón social. NULL = sin condición propia'`
		);
		await queryRunner.query(`ALTER TABLE "contracts" ADD "document_type" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "contracts"."document_type" IS 'Tipo de documento que emite el contrato: FACTURA o FACTURA_EXPORTACION (de él se deriva invoices.export_type). Sugerido por país emisor vs receptor. NULL = contratos anteriores a v2'`
		);
		await queryRunner.query(`ALTER TABLE "contracts" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(
			`COMMENT ON COLUMN "contracts"."deleted_at" IS 'Borrado lógico (solo borradores En revisión sin facturas, con evento DELETED). NULL = vigente'`
		);
		await queryRunner.query(
			`ALTER TABLE "contracts" ADD CONSTRAINT "contracts_payment_terms_check" CHECK ((payment_terms IS NULL) OR CASE (payment_terms ->> 'kind'::text) WHEN 'net'::text THEN CASE WHEN (jsonb_typeof((payment_terms -> 'days'::text)) = 'number'::text) THEN ((((payment_terms ->> 'days'::text))::numeric >= (0)::numeric) AND (((payment_terms ->> 'days'::text))::numeric <= (365)::numeric)) ELSE false END WHEN 'end_of_month'::text THEN CASE WHEN (jsonb_typeof((payment_terms -> 'days'::text)) = 'number'::text) THEN ((((payment_terms ->> 'days'::text))::numeric >= (0)::numeric) AND (((payment_terms ->> 'days'::text))::numeric <= (365)::numeric)) ELSE false END WHEN 'day_of_next_month'::text THEN CASE WHEN (jsonb_typeof((payment_terms -> 'day'::text)) = 'number'::text) THEN ((((payment_terms ->> 'day'::text))::numeric >= (1)::numeric) AND (((payment_terms ->> 'day'::text))::numeric <= (31)::numeric)) ELSE false END ELSE false END)`
		);
		await queryRunner.query(
			`ALTER TABLE "contracts" ADD CONSTRAINT "contracts_document_type_check" CHECK (((document_type IS NULL) OR (document_type = ANY (ARRAY['FACTURA'::text, 'FACTURA_EXPORTACION'::text]))))`
		);
		await queryRunner.query(
			`ALTER TABLE "contracts" ADD CONSTRAINT "contracts_billing_anchor_day_check" CHECK (((billing_anchor_day >= 1) AND (billing_anchor_day <= 31)))`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "contracts" DROP CONSTRAINT IF EXISTS "contracts_billing_anchor_day_check"`);
		await queryRunner.query(`ALTER TABLE "contracts" DROP CONSTRAINT IF EXISTS "contracts_document_type_check"`);
		await queryRunner.query(`ALTER TABLE "contracts" DROP CONSTRAINT IF EXISTS "contracts_payment_terms_check"`);
		await queryRunner.query(`ALTER TABLE "contracts" DROP COLUMN IF EXISTS "deleted_at"`);
		await queryRunner.query(`ALTER TABLE "contracts" DROP COLUMN IF EXISTS "document_type"`);
		await queryRunner.query(`ALTER TABLE "contracts" DROP COLUMN IF EXISTS "payment_terms"`);
		await queryRunner.query(`ALTER TABLE "contracts" DROP COLUMN IF EXISTS "billing_anchor_day"`);
	}
}
