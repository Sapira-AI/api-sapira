import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Contratos v2 · catálogo de documentos tributarios (`docs/v2-rediseno/mapa-v2-contratos.md` §6):
 *
 * 1. `tax_document_types`: catálogo compartido (sin holding) de documentos tributarios por país ISO-2, con `*` como
 *    comodín genérico. Lo define `entities/contratos/tax-document-type.entity.ts`; las filas las carga el seed
 *    `seed/003-tax-document-types.sql` y la lectura la habilita `rls/tax_document_types_select_authenticated.sql`.
 * 2. `contracts.tax_document_type_id` (FK al catálogo, NULL en los contratos anteriores). `contracts.document_type`
 *    sigue existiendo como familia derivada (`kind = export_invoice` → FACTURA_EXPORTACION, resto → FACTURA), así los
 *    lectores actuales (`export_type`, generador, front viejo) no cambian.
 *
 * Escrita a mano con la forma que emite `migration:generate` para estas entities (recortada). RLS de la tabla nueva
 * activado a mano: TypeORM no lo modela.
 *
 * Orden de despliegue: 1) esta migración, 2) `postgres:assets --only seed/003-tax-document-types.sql
 * --only "rls/tax_document_types_select_authenticated.sql"`, 3) el código que consulta el catálogo (sin las filas,
 * `form-options` devuelve el catálogo vacío y la creación cae al tipo de documento sugerido, como hoy).
 */
export class CreateTaxDocumentTypes1790620000000 implements MigrationInterface {
	name = 'CreateTaxDocumentTypes1790620000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE TABLE "tax_document_types" (
				"id" uuid NOT NULL DEFAULT gen_random_uuid(),
				"country_code" text NOT NULL,
				"code" text NOT NULL,
				"name" text NOT NULL,
				"kind" text NOT NULL,
				"is_electronic" boolean NOT NULL DEFAULT false,
				"sort" smallint NOT NULL DEFAULT '0',
				"active" boolean NOT NULL DEFAULT true,
				"created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
				CONSTRAINT "tax_document_types_country_code_code_key" UNIQUE ("country_code", "code"),
				CONSTRAINT "tax_document_types_kind_check" CHECK ("kind" = ANY (ARRAY['invoice'::text, 'export_invoice'::text, 'credit_note'::text, 'debit_note'::text, 'receipt'::text])),
				CONSTRAINT "tax_document_types_pkey" PRIMARY KEY ("id")
			)`
		);
		await queryRunner.query(
			`COMMENT ON TABLE "tax_document_types" IS 'Catálogo compartido de documentos tributarios por país (ISO-2, o * como comodín). code = código oficial cuando existe (SII 33/34/61, SUNAT 01/03, CFDI-I/E, DIAN FE/NC). kind = familia fiscal; de ella se deriva contracts.document_type'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "tax_document_types"."country_code" IS 'País ISO-2 del documento, o * para el comodín genérico'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "tax_document_types"."code" IS 'Código oficial del documento en su país (33, 01, CFDI-I, FE…) o genérico (FACTURA)'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "tax_document_types"."name" IS 'Nombre en español neutro'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "tax_document_types"."kind" IS 'Familia fiscal: invoice, export_invoice, credit_note, debit_note o receipt'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "tax_document_types"."sort" IS 'Orden de presentación dentro del país'`);
		await queryRunner.query(`CREATE INDEX "idx_tax_document_types_country_active" ON "tax_document_types" ("country_code", "active")`);
		// Tabla nueva: RLS a mano (los assets de rls/ solo declaran policies). La API entra con rol privilegiado; el Data API
		// del front la lee con la policy `tax_document_types_select_authenticated`.
		await queryRunner.query(`ALTER TABLE "tax_document_types" ENABLE ROW LEVEL SECURITY`);

		await queryRunner.query(`ALTER TABLE "contracts" ADD "tax_document_type_id" uuid`);
		await queryRunner.query(
			`COMMENT ON COLUMN "contracts"."tax_document_type_id" IS 'Documento tributario del catálogo tax_document_types que emite el contrato (33, 34, 110, 01, CFDI-I…). document_type es su familia derivada (kind export_invoice → FACTURA_EXPORTACION, resto → FACTURA). NULL = contratos anteriores al catálogo'`
		);
		await queryRunner.query(`CREATE INDEX "idx_contracts_tax_document_type_id" ON "contracts" ("tax_document_type_id")`);
		await queryRunner.query(
			`ALTER TABLE "contracts" ADD CONSTRAINT "contracts_tax_document_type_id_fkey" FOREIGN KEY ("tax_document_type_id") REFERENCES "tax_document_types"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// `document_type` conserva la familia, así que quitar la referencia al catálogo no pierde la decisión fiscal.
		await queryRunner.query(`ALTER TABLE "contracts" DROP CONSTRAINT "contracts_tax_document_type_id_fkey"`);
		await queryRunner.query(`DROP INDEX "public"."idx_contracts_tax_document_type_id"`);
		await queryRunner.query(`ALTER TABLE "contracts" DROP COLUMN "tax_document_type_id"`);
		await queryRunner.query(`DROP INDEX "public"."idx_tax_document_types_country_active"`);
		await queryRunner.query(`DROP TABLE "tax_document_types"`);
	}
}
