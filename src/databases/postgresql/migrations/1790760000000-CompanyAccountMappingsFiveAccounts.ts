import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M2 · Configuración v2 (`docs/v2-rediseno/spec-configuracion-v2.md` §5): las **5 cuentas** del asiento por compañía.
 *
 * `company_account_mappings` tenía 3 (Ingresos, Ingresos diferidos, Ingresos por facturar); los asientos de Ingresos salen "Sin código"
 * en Cuentas por cobrar y Diferencia de cambio. Se agregan las dos que faltan con su código, nombre y código del ERP, **todas nullable y
 * sin default** (aditivo: el front actual no las conoce y sigue igual; 0 de 24 compañías tienen fila hoy). Las escribe
 * `PUT /settings/companies/:id/accounts`. Que los asientos las lean es un cambio de Ingresos (módulo cerrado) que va con OK (D12).
 *
 * Entity: `entities/clientes/company-account-mapping.entity.ts`. **NO APLICADA** al 02-10.
 */
export class CompanyAccountMappingsFiveAccounts1790760000000 implements MigrationInterface {
	name = 'CompanyAccountMappingsFiveAccounts1790760000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(`ALTER TABLE "company_account_mappings" ADD "receivable_account_code" text`);
		await queryRunner.query(`ALTER TABLE "company_account_mappings" ADD "receivable_account_name" text`);
		await queryRunner.query(`ALTER TABLE "company_account_mappings" ADD "fx_difference_account_code" text`);
		await queryRunner.query(`ALTER TABLE "company_account_mappings" ADD "fx_difference_account_name" text`);
		await queryRunner.query(`ALTER TABLE "company_account_mappings" ADD "external_receivable_code" text`);
		await queryRunner.query(`ALTER TABLE "company_account_mappings" ADD "external_fx_difference_code" text`);
		await queryRunner.query(
			`COMMENT ON COLUMN "company_account_mappings"."receivable_account_code" IS 'Código de la cuenta Cuentas por cobrar (asiento de facturación)'`
		);
		await queryRunner.query(`COMMENT ON COLUMN "company_account_mappings"."receivable_account_name" IS 'Nombre de la cuenta Cuentas por cobrar'`);
		await queryRunner.query(
			`COMMENT ON COLUMN "company_account_mappings"."fx_difference_account_code" IS 'Código de la cuenta Diferencia de cambio'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "company_account_mappings"."fx_difference_account_name" IS 'Nombre de la cuenta Diferencia de cambio'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "company_account_mappings"."external_receivable_code" IS 'Código de Cuentas por cobrar en el ERP'`
		);
		await queryRunner.query(
			`COMMENT ON COLUMN "company_account_mappings"."external_fx_difference_code" IS 'Código de Diferencia de cambio en el ERP'`
		);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		for (const column of [
			'external_fx_difference_code',
			'external_receivable_code',
			'fx_difference_account_name',
			'fx_difference_account_code',
			'receivable_account_name',
			'receivable_account_code',
		]) {
			await queryRunner.query(`ALTER TABLE "company_account_mappings" DROP COLUMN IF EXISTS "${column}"`);
		}
	}
}
