import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alinea el default de `processing_status` con su propio CHECK en las dos tablas de
 * staging de facturas de Odoo.
 *
 * `odoo_invoices_stg` y `odoo_invoice_lines_stg` tienen `DEFAULT 'pending'`, pero su
 * CHECK solo admite `create | update | processed | error`. Un INSERT que omita la
 * columna produce una fila que el CHECK rechaza con 23514.
 *
 * ⚠️ CORRECCIÓN (verificado en producción el 2026-09-14). La versión anterior de este
 * comentario decía que el default nunca llegaba al CHECK porque ambas tablas tenían un
 * BEFORE INSERT que asignaba la columna, y nombraba `set_invoice_processing_status()` y
 * `classify_invoice_line_before_insert()`. **Eso es falso: ni esas funciones ni esos
 * triggers existen en producción.** Las dos tablas tienen un solo trigger cada una, el de
 * `updated_at` (`update_invoice_timestamp_trigger` y
 * `update_invoice_line_timestamp_trigger`). Las dos funciones son 2 de los 7 assets
 * huérfanos del corpus: el comentario se escribió leyendo `functions/`, no la base.
 *
 * Lo real, entonces: **el default sí llega al CHECK. Cualquier INSERT que omita
 * `processing_status` falla hoy, en producción, con 23514.** No se manifiesta porque
 * todos los escritores fijan la columna explícitamente —`InvoiceProcessingService` y el
 * pipeline de staging—, pero la trampa está armada y se dispara en cuanto alguien inserte
 * sin especificarla. Esto no es una precaución: es la corrección de un defecto activo.
 *
 * Se corrige el default en vez de ampliar el CHECK porque `'pending'` es vocabulario
 * muerto: ningún trigger lo emite y sus tres lectores (`get_invoice_staging_stats`,
 * `cleanup_duplicate_pending_records` y `process_partner_staging_*`) no tienen callers
 * o filtran sobre un valor que nunca existe. `InvoiceProcessingService` ya redefinió
 * "pending" como `create | update`, y su loop de procesamiento filtra
 * `In(['create','update','error'])`: admitir `'pending'` en el CHECK dejaría filas
 * invisibles para el pipeline en vez de fallar de forma visible.
 *
 * `'create'` —y no `DROP DEFAULT`— porque es el valor que deja la fila procesable: el loop
 * de `InvoiceProcessingService` filtra `In(['create','update','error'])`, así que una fila
 * que entre con `'create'` se procesa. Un NULL tampoco viola el CHECK, pero queda fuera de
 * ese filtro y se pierde en silencio, que es el modo de falla que hay que evitar.
 *
 * No toca datos existentes: verificado en producción, las dos tablas tienen 0 filas con
 * `'pending'` —imposible por el CHECK— y sus valores reales son `processed` y `update`.
 *
 * Escrita a mano: `migration:generate` no detecta cambios de default sobre columnas
 * que ya existen con el mismo tipo y nulabilidad.
 */
export class AlignStagingProcessingStatusDefault1788953100000 implements MigrationInterface {
	name = 'AlignStagingProcessingStatusDefault1788953100000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "public"."odoo_invoices_stg" ALTER COLUMN "processing_status" SET DEFAULT 'create'`);
		await queryRunner.query(`ALTER TABLE "public"."odoo_invoice_lines_stg" ALTER COLUMN "processing_status" SET DEFAULT 'create'`);

		await queryRunner.query(
			`COMMENT ON COLUMN "public"."odoo_invoices_stg"."processing_status" IS 'Estado del procesamiento: create, update, processed, error'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "public"."odoo_invoice_lines_stg"."processing_status" IS 'Estado del procesamiento: create, update, processed, error'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// Restaura el estado de producción previo, con default inválido incluido.
		await queryRunner.query(`ALTER TABLE "public"."odoo_invoice_lines_stg" ALTER COLUMN "processing_status" SET DEFAULT 'pending'`);
		await queryRunner.query(`ALTER TABLE "public"."odoo_invoices_stg" ALTER COLUMN "processing_status" SET DEFAULT 'pending'`);

		await queryRunner.query(`COMMENT ON COLUMN "public"."odoo_invoice_lines_stg"."processing_status" IS NULL`);
		await queryRunner.query(
			`COMMENT ON COLUMN "public"."odoo_invoices_stg"."processing_status" IS 'Estado del procesamiento: pending, processed, error'`
		);
	}
}
