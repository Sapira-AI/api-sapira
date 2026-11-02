import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Catálogo de documentos tributarios (Domi 02-11, bug B de soporte): México y Perú no tenían **factura de exportación**, así que un contrato
 * con razón social de otro país quedaba con la factura nacional (CFDI de ingreso 16 % / factura 18 %) o, al elegir la familia de exportación
 * a mano, sin documento del catálogo (`tax_document_type_id` NULL). Agrega las dos filas exentas (`kind = export_invoice`, `tax_rate = 0`):
 *
 * - MX `CFDI-I-EXP` "Factura CFDI de ingreso de exportación" (CFDI de ingreso con complemento de comercio exterior; IVA 0 %, art. 29 LIVA).
 * - PE `01-EXP` "Factura electrónica de exportación" (factura 01 de exportación; IGV 0 %, art. 33 LIGV).
 *
 * Idempotente por (country_code, code), como el seed 003. Entornos nuevos: `seed/009-tax-document-types-export-mx-pe.sql`. El motor ya
 * resuelve 0 % para la familia FACTURA_EXPORTACION (`resolveTaxRate`): la tasa explícita deja el catálogo consistente con CL 110.
 */
const EXPORT_DOCUMENT_TYPES: readonly { country: string; code: string; name: string; sort: number }[] = [
	{ country: 'MX', code: 'CFDI-I-EXP', name: 'Factura CFDI de ingreso de exportación', sort: 15 },
	{ country: 'PE', code: '01-EXP', name: 'Factura electrónica de exportación', sort: 15 },
];

export class TaxDocumentTypesExportMxPe1792500000000 implements MigrationInterface {
	name = 'TaxDocumentTypesExportMxPe1792500000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`INSERT INTO "tax_document_types" ("country_code", "code", "name", "kind", "is_electronic", "sort", "active", "tax_rate")
			SELECT v.country_code, v.code, v.name, 'export_invoice', TRUE, v.sort, TRUE, 0
			FROM unnest($1::text[], $2::text[], $3::text[], $4::int[]) AS v(country_code, code, name, sort)
			ON CONFLICT ("country_code", "code") DO NOTHING`,
			[
				EXPORT_DOCUMENT_TYPES.map((row) => row.country),
				EXPORT_DOCUMENT_TYPES.map((row) => row.code),
				EXPORT_DOCUMENT_TYPES.map((row) => row.name),
				EXPORT_DOCUMENT_TYPES.map((row) => row.sort),
			]
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// Solo si ningún contrato ni factura los referencia (si no, la FK falla y la baja se detiene: es lo correcto).
		await queryRunner.query(`DELETE FROM "tax_document_types" WHERE ("country_code", "code") IN (('MX', 'CFDI-I-EXP'), ('PE', '01-EXP'))`);
	}
}
