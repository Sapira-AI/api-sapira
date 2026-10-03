import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M11 · Configuración v2 ronda 3 (decisión de Domi 03-10, simplificada: sin activación por compañía): **tasa de impuesto por documento**.
 *
 * `tax_document_types.tax_rate numeric NULL` (porcentaje, 19 = 19 %; NULL = usa la tasa de la compañía) con CHECK 0–100 y valores:
 * CL 33 = 19, 34 = 0, 110 = 0, 111 = 0, 112 = 0; PE 01 = 18, 03 = 18; MX CFDI-I = 16; CO FE = 0 (además el motor deja Colombia en 0 y el
 * IVA lo aplica el ERP). Notas de crédito/débito nacionales y genéricos `*` quedan NULL. El motor de facturación usa esta tasa cuando el
 * contrato tiene ese documento (exportación sigue 0). Entornos nuevos (el seed 003 corre después de las migraciones):
 * `seed/006-tax-document-types-tax-rate.sql`.
 *
 * Aditiva: el front actual no lee la columna. Entity: `entities/contratos/tax-document-type.entity.ts`. **NO APLICADA** al 03-10.
 */
const TAX_DOCUMENT_RATES: readonly [country: string, code: string, rate: number][] = [
	['CL', '33', 19],
	['CL', '34', 0],
	['CL', '110', 0],
	['CL', '111', 0],
	['CL', '112', 0],
	['PE', '01', 18],
	['PE', '03', 18],
	['MX', 'CFDI-I', 16],
	['CO', 'FE', 0],
];

export class TaxDocumentTypesTaxRate1790820000000 implements MigrationInterface {
	name = 'TaxDocumentTypesTaxRate1790820000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "tax_document_types" ADD "tax_rate" numeric`);
		await queryRunner.query(
			`COMMENT ON COLUMN "tax_document_types"."tax_rate" IS 'Tasa de impuesto del documento en porcentaje (19 = 19 %). NULL = usa la tasa de la compañía'`
		);
		await queryRunner.query(
			`ALTER TABLE "tax_document_types" ADD CONSTRAINT "tax_document_types_tax_rate_check" CHECK ("tax_rate" IS NULL OR ("tax_rate" >= 0 AND "tax_rate" <= 100))`
		);
		await queryRunner.query(
			`UPDATE "tax_document_types" t SET "tax_rate" = v.rate
			FROM unnest($1::text[], $2::text[], $3::numeric[]) AS v(country_code, code, rate)
			WHERE t.country_code = v.country_code AND t.code = v.code`,
			[TAX_DOCUMENT_RATES.map((row) => row[0]), TAX_DOCUMENT_RATES.map((row) => row[1]), TAX_DOCUMENT_RATES.map((row) => row[2])]
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "tax_document_types" DROP CONSTRAINT IF EXISTS "tax_document_types_tax_rate_check"`);
		await queryRunner.query(`ALTER TABLE "tax_document_types" DROP COLUMN IF EXISTS "tax_rate"`);
	}
}
