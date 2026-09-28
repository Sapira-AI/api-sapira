import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Modelo FX de contratos v2 (decidido con Domi, 28-09-2026). Mapa: `docs/v2-rediseno/mapa-v2-contratos.md` → FX.
 *
 * Regla única para toda fila de tasa: "1 [from_currency] = rate [to_currency]". Una fila directa (from = moneda del
 * contrato) se MULTIPLICA; una inversa (from = otra moneda, to = moneda del contrato) es 1/rate. La inversa queda solo
 * por datos viejos: v2 escribe siempre contrato → otra moneda.
 *
 * - `contract_fx_period_rates.purpose` (text NOT NULL DEFAULT 'company', CHECK company|invoice): la misma tabla guarda
 *   las tasas fijas de devengo en moneda de la compañía (`company`, política `fixed_period`) y las de facturación
 *   (`invoice`, `fx_invoice_policy = 'fixed'`). El default mantiene funcionando al front viejo (inserta sin purpose) y
 *   deja las filas existentes como `company`. Índice (contract_id, purpose) para las dos lecturas.
 * - `companies.fx_company_policy` (text NOT NULL DEFAULT 'monthly_avg', CHECK solo monthly_avg): política por defecto
 *   de la compañía para el devengo de contratos en otra moneda; el contrato la copia al crearse. Un FX fijo se define
 *   solo por contrato (Domi 28-09): el CHECK nunca crece a `fixed_period`. Se editará en Configuración del holding →
 *   configuración de las compañías cuando ese módulo migre.
 *
 * Escrita a mano con la forma que emite `migration:generate` para estas dos entities. Defaults constantes: no reescribe
 * las tablas.
 *
 * ⚠️ Orden de despliegue: 1) esta migración, 2) los assets `revenue_schedule_apply_fx_for_contract`,
 * `calculate_contract_fx_rate` y `bulk_confirm_fx_policy`, 3) la migración `1790610000001-FixHankaCompanyFxRatesDirection`
 * (se niega a correr sin el asset nuevo), 4) el código que declara las columnas.
 */
export class AddFxRatePurposeAndCompanyFxPolicy1790610000000 implements MigrationInterface {
	name = 'AddFxRatePurposeAndCompanyFxPolicy1790610000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "contract_fx_period_rates" ADD "purpose" text NOT NULL DEFAULT 'company'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "contract_fx_period_rates"."purpose" IS 'Uso de la tasa fija: company (devengo en moneda de la compañía, fx_company_policy = fixed_period) o invoice (tipo de cambio fijo de facturación, fx_invoice_policy = fixed). Regla: 1 [from_currency] = rate [to_currency]'`
		);
		await queryRunner.query(
			`ALTER TABLE "contract_fx_period_rates" ADD CONSTRAINT "contract_fx_period_rates_purpose_check" CHECK (purpose = ANY (ARRAY['company'::text, 'invoice'::text]))`
		);
		await queryRunner.query(`CREATE INDEX "idx_contract_fx_rates_contract_purpose" ON "contract_fx_period_rates" ("contract_id", "purpose")`);

		await queryRunner.query(`ALTER TABLE "companies" ADD "fx_company_policy" text NOT NULL DEFAULT 'monthly_avg'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "companies"."fx_company_policy" IS 'Política por defecto de la compañía para el devengo de contratos en otra moneda; hoy solo monthly_avg. Un FX fijo se define solo por contrato (contract_fx_period_rates, purpose = company). Se editará en Configuración del holding → configuración de las compañías cuando ese módulo migre'`
		);
		await queryRunner.query(
			`ALTER TABLE "companies" ADD CONSTRAINT "companies_fx_company_policy_check" CHECK (fx_company_policy = ANY (ARRAY['monthly_avg'::text]))`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// Quitar `purpose` convertiría las tasas de facturación en tasas de devengo: no se revierte si ya hay alguna.
		const [invoiceRates] = (await queryRunner.query(
			`SELECT COUNT(*)::int AS count FROM "contract_fx_period_rates" WHERE "purpose" = 'invoice'`
		)) as Array<{ count: number }>;

		if (Number(invoiceRates?.count) > 0) {
			throw new Error(
				`No se revierte: hay ${invoiceRates.count} tasas de facturación (purpose = 'invoice') que pasarían a leerse como tasas de devengo. Muévelas o bórralas antes.`
			);
		}

		await queryRunner.query(`ALTER TABLE "companies" DROP CONSTRAINT "companies_fx_company_policy_check"`);
		await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN "fx_company_policy"`);
		await queryRunner.query(`DROP INDEX "public"."idx_contract_fx_rates_contract_purpose"`);
		await queryRunner.query(`ALTER TABLE "contract_fx_period_rates" DROP CONSTRAINT "contract_fx_period_rates_purpose_check"`);
		await queryRunner.query(`ALTER TABLE "contract_fx_period_rates" DROP COLUMN "purpose"`);
	}
}
