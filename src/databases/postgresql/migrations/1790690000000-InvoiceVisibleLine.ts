import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Facturas en el Contrato 360 · etapa 6: facturar por OC con línea visible ↔ líneas internas (`docs/v2-rediseno/spec-facturas-en-contrato-360.md`
 * §3.7b, decisión 5 de Domi). Esquema **aditivo**: una sola columna nueva, nada se renombra ni se borra, ningún trigger ni función.
 *
 * `invoice_items.visible_line_id` (uuid NULL, FK a `invoice_items(id)` ON DELETE SET NULL): la línea es **interna** y está ligada a la
 * línea visible del documento (la que cubre una OC por un monto cerrado). NULL = línea normal. No se crea `is_visible` (regla de Domi, sin
 * campos duplicados): una línea es visible cuando `quantity <> 0 AND visible_line_id IS NULL`. El índice sirve el desplegable de internas por
 * línea visible y el filtro del envío al ERP (`mapInvoiceToOdooFormat` debe omitir `visible_line_id IS NOT NULL`, cambio de Domi/Leon).
 *
 * Orden de despliegue: 1) esta migración, 2) el código: la API lee `invoice_items.visible_line_id` en el detalle de factura, el editor, la
 * reorganización y "Facturar por OC"; sin la migración esas consultas fallan.
 */
export class InvoiceVisibleLine1790690000000 implements MigrationInterface {
	name = 'InvoiceVisibleLine1790690000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "invoice_items" ADD "visible_line_id" uuid`);
		await queryRunner.query(
			`ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_visible_line_id_fkey" FOREIGN KEY ("visible_line_id") REFERENCES "invoice_items"("id") ON DELETE SET NULL ON UPDATE NO ACTION`
		);
		await queryRunner.query(
			`CREATE INDEX "idx_invoice_items_visible_line_id" ON "invoice_items" ("visible_line_id") WHERE visible_line_id IS NOT NULL`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "invoice_items"."visible_line_id" IS 'línea interna ligada a la línea visible del documento; NULL = línea normal'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP INDEX "public"."idx_invoice_items_visible_line_id"`);
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_visible_line_id_fkey"`);
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP COLUMN "visible_line_id"`);
	}
}
