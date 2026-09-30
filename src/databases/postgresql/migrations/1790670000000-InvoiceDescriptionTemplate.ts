import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Facturas en el Contrato 360 · etapa 3: constructor de descripción (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.6). Esquema
 * **aditivo**: tres columnas nuevas, nada se renombra ni se borra, ningún trigger ni función.
 *
 * 1. `contracts.invoice_description_template` (jsonb, NULL = la glosa de hoy): plantilla de bloques `{ separator?, blocks: [{ type,
 *    format?, text? }] }` con la que el generador v2 y el 360 arman la descripción de cada línea (`invoice-description.ts`).
 * 2. `invoice_items.description_locked` (boolean NOT NULL DEFAULT false): la glosa se escribió a mano (`mode: 'set'`); ninguna
 *    regeneración la toca hasta "Volver a la plantilla" (`mode: 'unlock'`). Las filas existentes quedan en false.
 * 3. `tax_document_types.description_max_chars` (integer, NULL = sin límite): largo máximo de la descripción de una línea en el
 *    documento. Chile (SII, `NmbItem`) = 80 para todos sus documentos; México y Perú quedan NULL hasta que Leon confirme el límite.
 *    El UPDATE fija el valor en las filas ya sembradas. El seed `seed/003-tax-document-types.sql` NO cambia: un seed aplicado es
 *    inmutable (`ON CONFLICT DO NOTHING` no converge; el aplicador lo bloquea). En un entorno nuevo el seed corre después de esta
 *    migración y las filas CL nacen sin límite: ahí hay que repetir el UPDATE en una migración posterior al seed.
 *
 * Orden de despliegue: 1) esta migración, 2) el código: la API lee `invoice_description_template`, `description_locked` y
 * `description_max_chars` (detalle de factura, activación, modificaciones, consumos y el constructor); sin la migración esas consultas fallan.
 */
export class InvoiceDescriptionTemplate1790670000000 implements MigrationInterface {
	name = 'InvoiceDescriptionTemplate1790670000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// 1. contracts.invoice_description_template
		await queryRunner.query(`ALTER TABLE "contracts" ADD "invoice_description_template" jsonb`);
		await queryRunner.query(
			`COMMENT ON COLUMN "contracts"."invoice_description_template" IS 'Plantilla de descripción de las líneas de factura {separator?, blocks: [{type, format?, text?}]} (spec facturas §3.6). NULL = glosa estándar PRODUCTO Cuenta X - Periodo dd/mm/aaaa a dd/mm/aaaa'`
		);

		// 2. invoice_items.description_locked
		await queryRunner.query(`ALTER TABLE "invoice_items" ADD "description_locked" boolean NOT NULL DEFAULT false`);
		await queryRunner.query(
			`COMMENT ON COLUMN "invoice_items"."description_locked" IS 'true = descripción escrita a mano: ninguna regeneración (plantilla, consumos, modificaciones) la toca hasta volver a la plantilla'`
		);

		// 3. tax_document_types.description_max_chars (+ Chile = 80 en las filas ya sembradas)
		await queryRunner.query(`ALTER TABLE "tax_document_types" ADD "description_max_chars" integer`);
		await queryRunner.query(
			`COMMENT ON COLUMN "tax_document_types"."description_max_chars" IS 'Largo máximo de la descripción de una línea en el documento (SII NmbItem = 80). NULL = sin límite'`
		);
		await queryRunner.query(
			`UPDATE "tax_document_types" SET "description_max_chars" = 80 WHERE "country_code" = 'CL' AND "description_max_chars" IS NULL`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "tax_document_types" DROP COLUMN "description_max_chars"`);
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP COLUMN "description_locked"`);
		await queryRunner.query(`ALTER TABLE "contracts" DROP COLUMN "invoice_description_template"`);
	}
}
