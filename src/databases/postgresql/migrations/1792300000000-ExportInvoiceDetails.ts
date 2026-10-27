import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Factura de exportación electrónica (DTE 110) y sus notas (111, 112) desde los contratos.
 *
 * - `client_entities.city`: ciudad de la dirección legal (`CiudadRecep` del DTE, hasta 20 caracteres). La factura de exportación la
 *   exige para el receptor extranjero, que no tiene comuna chilena. El largo se valida en la API, no con un CHECK.
 * - `contracts.export_details`: datos estables de la exportación (servicios o bienes, modalidad y cláusula de venta, forma de pago, vía
 *   de transporte, puertos y país de destino), con los códigos de las tablas de Aduana. Todos opcionales.
 * - `invoices.export_details`: datos del embarque de una factura de bienes (bultos, pesos, flete, seguro, DUS), que se completan al
 *   emitir y pisan los del contrato.
 *
 * Solo esquema: las filas existentes quedan en NULL. ⚠️ Orden de despliegue: correr esta migración ANTES de desplegar el código que
 * declara las columnas en `ClientEntity`, `Contract` e `Invoice` (TypeORM las seleccionaría sin que existan).
 */
export class ExportInvoiceDetails1792300000000 implements MigrationInterface {
	name = 'ExportInvoiceDetails1792300000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "public"."client_entities" ADD COLUMN IF NOT EXISTS "city" text`);
		await queryRunner.query(`ALTER TABLE "public"."contracts" ADD COLUMN IF NOT EXISTS "export_details" jsonb`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" ADD COLUMN IF NOT EXISTS "export_details" jsonb`);
		await queryRunner.query(
			`COMMENT ON COLUMN "public"."client_entities"."city" IS 'Ciudad de la dirección legal (CiudadRecep del DTE, hasta 20 caracteres): obligatoria en la factura de exportación. NULL = sin ciudad'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "public"."contracts"."export_details" IS 'Datos de exportación del contrato para la factura de exportación (DTE 110): {kind: servicios|bienes, sale_modality, sale_clause, payment_form, transport_route, carrier_name, port_of_loading, port_of_unloading, destination_country}, con los códigos de Aduana. Todos opcionales. NULL = sin datos de exportación'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "public"."invoices"."export_details" IS 'Datos del embarque de una factura de exportación de bienes (DTE 110): {total_packages, package_type, gross_weight, net_weight, weight_unit, freight, insurance, sale_clause_total, dus_number, dus_date}. Pisan los del contrato. NULL = sin datos'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "public"."invoices"."dte_tipo" IS 'Tipo SII del DTE emitido (33, 34, 56, 61, 110, 111, 112)'`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`COMMENT ON COLUMN "public"."invoices"."dte_tipo" IS 'Tipo SII del DTE emitido (33, 34, 56, 61)'`);
		await queryRunner.query(`ALTER TABLE "public"."invoices" DROP COLUMN IF EXISTS "export_details"`);
		await queryRunner.query(`ALTER TABLE "public"."contracts" DROP COLUMN IF EXISTS "export_details"`);
		await queryRunner.query(`ALTER TABLE "public"."client_entities" DROP COLUMN IF EXISTS "city"`);
	}
}
