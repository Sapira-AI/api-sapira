import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Multimoneda en el contrato · MM1 (`docs/v2-rediseno/spec-multimoneda-contrato.md` §3 #1, decisiones de Domi 01-10). Esquema **aditivo**:
 * ninguna columna nueva, nada se renombra ni se borra.
 *
 * `contract_fx_period_rates.purpose` suma `item`: tasa **fija** ítem → contrato (`from_currency` = moneda del ítem, `to_currency` = moneda
 * del contrato), pactada al crear el contrato o al agregar el ítem, que convierte a moneda de contrato el MRR, el TCV (`contracts.total_value`)
 * y el devengo (RSM) de los ítems en otra moneda. Una fila sin fechas = todo el contrato (regla de `resolveFx`); por período opcional.
 * `company` (contrato → compañía) e `invoice` (moneda del ítem → factura) no cambian. Regla única: "1 [from_currency] = rate [to_currency]".
 *
 * Orden de despliegue: 1) esta migración, 2) los assets `validate_contract_item_currency_consistency`, `validate_contract_currency_consistency`,
 * `change_contract_currency` y `revenue_schedule_rebuild_contract_ccy` (`postgres:assets`), 3) el código que escribe `purpose = 'item'` y
 * acepta ítems en otra moneda con `contracts.requires_multicurrency_billing`. Sin la migración, insertar una tasa `item` viola el CHECK.
 *
 * Además apaga el job pg_cron `auto-renew-contract-items` (Domi 01-10, `plan-coexistencia-funciones.md` decisión #5): la auto-renovación
 * legacy (`process_auto_renewals`) fallaba siempre y desde el 02-10 entraban 290 ítems de SimpliRoute a su ventana de 90 días. Un
 * `cron.unschedule` es una transición, así que va aquí y no como asset (el asset `cron/auto-renew-contract-items.sql` se elimina); la
 * renovación v2 con confirmación por holding (R2) lo reemplaza. Ya se desprogramó a mano en QA y producción el 01-10: idempotente.
 */
export class MulticurrencyContract1790700000000 implements MigrationInterface {
	name = 'MulticurrencyContract1790700000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "contract_fx_period_rates" DROP CONSTRAINT "contract_fx_period_rates_purpose_check"`);
		await queryRunner.query(
			`ALTER TABLE "contract_fx_period_rates" ADD CONSTRAINT "contract_fx_period_rates_purpose_check" CHECK (purpose = ANY (ARRAY['company'::text, 'invoice'::text, 'item'::text]))`
		);
		await queryRunner.query(`DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-renew-contract-items') THEN
    PERFORM cron.unschedule('auto-renew-contract-items');
  END IF;
END
$cron$`);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_fx_period_rates"."purpose" IS 'Uso de la tasa fija: company (devengo en moneda de la compañía, fx_company_policy = fixed_period), invoice (tipo de cambio de facturación por par moneda del ítem → factura, fx_invoice_policy = fixed) o item (tasa fija pactada moneda del ítem → contrato para MRR, TCV y devengo de contratos multimoneda). Regla: 1 [from_currency] = rate [to_currency]'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// El job `auto-renew-contract-items` no se vuelve a programar: fallaba siempre y su reemplazo es la renovación v2.
		// Quitar `item` dejaría filas que violan el CHECK viejo: no se revierte si ya hay alguna.
		const [itemRates] = (await queryRunner.query(
			`SELECT COUNT(*)::int AS count FROM "contract_fx_period_rates" WHERE "purpose" = 'item'`
		)) as Array<{
			count: number;
		}>;

		if (Number(itemRates?.count) > 0) {
			throw new Error(
				`No se revierte: hay ${itemRates.count} tasas ítem → contrato (purpose = 'item') de contratos multimoneda. Muévelas o bórralas antes.`
			);
		}

		await queryRunner.query(`ALTER TABLE "contract_fx_period_rates" DROP CONSTRAINT "contract_fx_period_rates_purpose_check"`);
		await queryRunner.query(
			`ALTER TABLE "contract_fx_period_rates" ADD CONSTRAINT "contract_fx_period_rates_purpose_check" CHECK (purpose = ANY (ARRAY['company'::text, 'invoice'::text]))`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_fx_period_rates"."purpose" IS 'Uso de la tasa fija: company (devengo en moneda de la compañía, fx_company_policy = fixed_period) o invoice (tipo de cambio fijo de facturación, fx_invoice_policy = fixed). Regla: 1 [from_currency] = rate [to_currency]'`
		);
	}
}
