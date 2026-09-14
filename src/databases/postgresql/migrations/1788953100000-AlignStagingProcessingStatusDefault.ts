import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Alinea el default de `processing_status` con su propio CHECK en las dos tablas de
 * staging de facturas de Odoo.
 *
 * `odoo_invoices_stg` y `odoo_invoice_lines_stg` tenían `DEFAULT 'pending'`, pero su
 * CHECK solo admite `create | update | processed | error`. Un INSERT que omita la
 * columna produce una fila que el CHECK rechaza con 23514.
 *
 * Por qué hoy no se manifiesta en producción: Postgres evalúa defaults → triggers
 * BEFORE ROW → CHECK, y ambas tablas tienen un BEFORE INSERT que asigna la columna en
 * todas sus rutas de salida, incluido el `EXCEPTION WHEN OTHERS`:
 *  - `invoice_processing_status_classifier` → `set_invoice_processing_status()`
 *  - `classify_invoice_line_trigger` → `classify_invoice_line_before_insert()`
 * El default nunca sobrevive hasta la validación. La trampa se arma cuando el trigger
 * no corre: `session_replication_role = 'replica'` (apply de replicación lógica,
 * `pg_restore --disable-triggers`), un `ALTER TABLE ... DISABLE TRIGGER`, o un esquema
 * creado desde las entities sin aplicar todavía los assets de `triggers/`.
 *
 * Se corrige el default en vez de ampliar el CHECK porque `'pending'` es vocabulario
 * muerto: ningún trigger lo emite y sus tres lectores (`get_invoice_staging_stats`,
 * `cleanup_duplicate_pending_records` y `process_partner_staging_*`) no tienen callers
 * o filtran sobre un valor que nunca existe. `InvoiceProcessingService` ya redefinió
 * "pending" como `create | update`, y su loop de procesamiento filtra
 * `In(['create','update','error'])`: admitir `'pending'` en el CHECK dejaría filas
 * invisibles para el pipeline en vez de fallar de forma visible.
 *
 * `'create'` —y no `DROP DEFAULT`— porque coincide con el fallback del propio
 * clasificador ("no puedo identificar la factura → create") y deja la fila procesable
 * si el trigger llegara a faltar; un NULL tampoco viola el CHECK, pero queda fuera del
 * loop de procesamiento y se pierde en silencio.
 *
 * No toca datos existentes: ninguna fila puede tener `'pending'`, porque el CHECK lo
 * viene rechazando desde siempre.
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
