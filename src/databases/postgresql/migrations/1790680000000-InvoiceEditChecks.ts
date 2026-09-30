import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Facturas en el Contrato 360 · etapa 4: editar una Por Emitir como un todo (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.4).
 * Sin columnas ni tablas nuevas (regla de Domi: nada duplicado): solo se amplían tres CHECK existentes.
 *
 * 1. `invoice_adjustments_type_check`: + `correction`. El motivo tipado de un desvío contra el plan se guarda en `invoice_adjustments`
 *    (type discount | downsell | upsell | correction, amount_diff, notes = motivo, adjusted_by) en lugar de una columna `plan_deviation`.
 * 2. `invoice_items_quantity_source_check`: + `manual`. Una línea editada a mano queda `quantity_source = 'manual'` (en lugar de una
 *    columna `source`); consumos, modificaciones y plantillas no la reescriben.
 * 3. `invoices_nc_revenue_treatment_check`: + `service_period` (devengo repartido en los meses del período de servicio de la línea). El
 *    mismo campo guarda el tratamiento del descuento puntual de una factura (`nc_discount_revenue_adjustment`).
 *
 * El down vuelve a los CHECK anteriores: si ya hay filas con los valores nuevos, el ALTER falla y el revert se detiene a propósito.
 * Orden de despliegue: 1) esta migración, 2) el asset `nc_discount_revenue_adjustment`, 3) el código (la API escribe `manual`,
 * `correction` y `service_period`; sin la migración esos INSERT/UPDATE fallan por el CHECK).
 */
export class InvoiceEditChecks1790680000000 implements MigrationInterface {
	name = 'InvoiceEditChecks1790680000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		// 1. invoice_adjustments.type + correction
		await queryRunner.query(`ALTER TABLE "invoice_adjustments" DROP CONSTRAINT "invoice_adjustments_type_check"`);
		await queryRunner.query(
			`ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_type_check" CHECK (type = ANY (ARRAY['discount'::text, 'downsell'::text, 'upsell'::text, 'reagenda'::text, 'correction'::text]))`
		);

		// 2. invoice_items.quantity_source + manual
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_quantity_source_check"`);
		await queryRunner.query(
			`ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_quantity_source_check" CHECK ((("quantity_source" IS NULL) OR ("quantity_source" = ANY (ARRAY['fixed'::text, 'consumption'::text, 'estimated'::text, 'pending'::text, 'manual'::text]))))`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "invoice_items"."quantity_source" IS 'Pricing v2: fixed | consumption | estimated | pending (pending = línea metered sin consumo informado) | manual (editada a mano en la Por Emitir: consumos, modificaciones y plantillas no la reescriben)'`
		);

		// 3. invoices.nc_revenue_treatment + service_period
		await queryRunner.query(`ALTER TABLE "invoices" DROP CONSTRAINT "invoices_nc_revenue_treatment_check"`);
		await queryRunner.query(
			`ALTER TABLE "invoices" ADD CONSTRAINT "invoices_nc_revenue_treatment_check" CHECK ((((nc_revenue_treatment IS NULL) OR (nc_revenue_treatment = ANY (ARRAY['impact_month'::text, 'defer_forward'::text, 'service_period'::text])))))`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "invoices"."nc_revenue_treatment" IS 'Devengo del descuento en RSM (impact_month = mes de emisión; defer_forward = meses restantes del ítem; service_period = meses del período de servicio de la línea). NC discount y facturas con descuento puntual (sublínea one_off del pricing_breakdown). NULL en el resto.'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`COMMENT ON COLUMN "invoices"."nc_revenue_treatment" IS 'Solo NC discount: devengo del descuento en RSM (impact_month = mes de la NC; defer_forward = meses restantes del ítem). NULL en facturas y NC de anulación/churn.'`
		);
		await queryRunner.query(`ALTER TABLE "invoices" DROP CONSTRAINT "invoices_nc_revenue_treatment_check"`);
		await queryRunner.query(
			`ALTER TABLE "invoices" ADD CONSTRAINT "invoices_nc_revenue_treatment_check" CHECK ((((nc_revenue_treatment IS NULL) OR (nc_revenue_treatment = ANY (ARRAY['impact_month'::text, 'defer_forward'::text])))))`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "invoice_items"."quantity_source" IS 'Pricing v2: fixed | consumption | estimated | pending (pending = línea metered sin consumo informado)'`
		);
		await queryRunner.query(`ALTER TABLE "invoice_items" DROP CONSTRAINT "invoice_items_quantity_source_check"`);
		await queryRunner.query(
			`ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_quantity_source_check" CHECK ((("quantity_source" IS NULL) OR ("quantity_source" = ANY (ARRAY['fixed'::text, 'consumption'::text, 'estimated'::text, 'pending'::text]))))`
		);
		await queryRunner.query(`ALTER TABLE "invoice_adjustments" DROP CONSTRAINT "invoice_adjustments_type_check"`);
		await queryRunner.query(
			`ALTER TABLE "invoice_adjustments" ADD CONSTRAINT "invoice_adjustments_type_check" CHECK (type = ANY (ARRAY['discount'::text, 'downsell'::text, 'upsell'::text, 'reagenda'::text]))`
		);
	}
}
