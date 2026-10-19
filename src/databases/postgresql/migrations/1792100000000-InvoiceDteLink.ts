import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Vínculo factura ↔ documento tributario electrónico (DTE) emitido por el servicio de facturación electrónica (api-factura), para
 * las compañías que emiten sin ERP (`front-lenosoft/app/docs/content/api-factura/proyecto/diseno-facturacion-sapira.md`).
 *
 * - En `invoices`: el DTE (`dte_id` en api-factura, tipo SII, folio, TrackId del envío al SII, ambiente), su resultado en el SII
 *   (`dte_status`: creado | enviado | aceptado | reparos | rechazado, con glosa y fecha) y la entrega al receptor por correo
 *   (`dte_receptor_email`, `dte_receptor_sent_at`, `dte_receptor_error`). Índice parcial para el job que consulta los enviados.
 *
 * Solo esquema: las facturas existentes quedan con todo en NULL (no tienen DTE). ⚠️ Orden de despliegue: correr esta migración ANTES
 * de desplegar el código que declara las columnas en `Invoice` (TypeORM las seleccionaría sin que existan). El DTE se entrega al
 * correo de la razón social (`client_entities.email`, «Correo (DTE)» en Clientes).
 */
export class InvoiceDteLink1792100000000 implements MigrationInterface {
	name = 'InvoiceDteLink1792100000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_id" text`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_tipo" integer`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_folio" integer`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_track_id" text`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_environment" text`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_status" text`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_status_detail" text`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_status_at" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_receptor_email" text`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_receptor_sent_at" TIMESTAMP WITH TIME ZONE`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "dte_receptor_error" text`);
		await queryRunner.query(
			`ALTER TABLE "public"."invoices" ADD CONSTRAINT "invoices_dte_status_check" CHECK ((dte_status IS NULL) OR (dte_status = ANY (ARRAY['creado'::text, 'enviado'::text, 'aceptado'::text, 'reparos'::text, 'rechazado'::text])))`
		);
		await queryRunner.query(
			`ALTER TABLE "public"."invoices" ADD CONSTRAINT "invoices_dte_environment_check" CHECK ((dte_environment IS NULL) OR (dte_environment = ANY (ARRAY['certificacion'::text, 'produccion'::text])))`
		);
		await queryRunner.query(`CREATE INDEX "idx_invoices_dte_status_enviado" ON "public"."invoices" ("holding_id") WHERE dte_status = 'enviado'`);
		for (const [column, comment] of [
			['dte_id', 'Id del DTE en el servicio de facturación electrónica (api-factura). NULL = la factura no se emitió como DTE desde Sapira'],
			['dte_tipo', 'Tipo SII del DTE emitido (33, 34, 56, 61)'],
			['dte_folio', 'Folio del DTE asignado por el SII (CAF); se copia a invoice_number'],
			['dte_track_id', 'TrackId del envío del DTE al SII'],
			['dte_environment', 'Ambiente SII en que se emitió el DTE: certificacion | produccion'],
			['dte_status', 'Estado del DTE: creado (sin enviar al SII) | enviado | aceptado | reparos | rechazado'],
			['dte_status_detail', 'Glosa del SII de la última consulta de estado'],
			['dte_status_at', 'Fecha de la última consulta o cambio de estado del DTE'],
			['dte_receptor_email', 'Correo de intercambio al que se envió el DTE (receptor)'],
			['dte_receptor_sent_at', 'Fecha del envío del DTE al receptor'],
			['dte_receptor_error', 'Último error al enviar el DTE al receptor (NULL si se envió o no se intentó)'],
		])
			await queryRunner.query(`COMMENT ON COLUMN "public"."invoices"."${column}" IS '${comment}'`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`DROP INDEX IF EXISTS "public"."idx_invoices_dte_status_enviado"`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" DROP CONSTRAINT IF EXISTS "invoices_dte_environment_check"`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" DROP CONSTRAINT IF EXISTS "invoices_dte_status_check"`);
		for (const column of [
			'dte_receptor_error',
			'dte_receptor_sent_at',
			'dte_receptor_email',
			'dte_status_at',
			'dte_status_detail',
			'dte_status',
			'dte_environment',
			'dte_track_id',
			'dte_folio',
			'dte_tipo',
			'dte_id',
		])
			await queryRunner.query(`ALTER TABLE "public"."invoices" DROP COLUMN IF EXISTS "${column}"`);
	}
}
