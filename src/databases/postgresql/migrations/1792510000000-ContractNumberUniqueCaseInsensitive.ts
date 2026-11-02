import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Número de contrato único **sin distinguir mayúsculas** (Domi 02-11). `contracts_holding_number_unique` (holding_id, contract_number)
 * dejaba convivir "ctr-2026-218" y "CTR-2026-218" (caso Avon / Farmacias EOS en SimpliRoute); la API los rechaza desde el 27-10
 * (`contract-drafts.service.ts`), pero el índice seguía sensible. Se reemplaza por `contracts_holding_number_unique_ci` sobre
 * (holding_id, lower(contract_number)) para contratos no borrados.
 *
 * Antes de crear el índice verifica que no queden repetidos salvo mayúsculas: si los hay, falla con la lista (se corrigen los datos primero,
 * con respaldo; en producción el único caso es ctr-2026-218, que se renumera en la misma entrega). Índice de expresión: TypeORM no lo declara,
 * así que la entity lo marca con `synchronize: false` y el SQL vive en `special-index/contracts_holding_number_unique_ci.sql`.
 */
export class ContractNumberUniqueCaseInsensitive1792510000000 implements MigrationInterface {
	name = 'ContractNumberUniqueCaseInsensitive1792510000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		const duplicates: { holding_id: string; number: string; total: number }[] = await queryRunner.query(
			`SELECT holding_id, lower(contract_number) AS number, count(*)::int AS total
			FROM contracts WHERE deleted_at IS NULL AND contract_number IS NOT NULL
			GROUP BY holding_id, lower(contract_number) HAVING count(*) > 1 ORDER BY 1, 2`
		);

		if (duplicates.length) {
			throw new Error(
				`Números de contrato repetidos salvo mayúsculas (corrígelos antes de crear el índice): ${duplicates
					.map((row) => `${row.number} ×${row.total} (holding ${row.holding_id})`)
					.join(', ')}`
			);
		}
		await queryRunner.query(
			`CREATE UNIQUE INDEX IF NOT EXISTS "contracts_holding_number_unique_ci" ON "contracts" ("holding_id", lower("contract_number")) WHERE "deleted_at" IS NULL`
		);
		await queryRunner.query(`DROP INDEX IF EXISTS "contracts_holding_number_unique"`);
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		await queryRunner.query(
			`CREATE UNIQUE INDEX IF NOT EXISTS "contracts_holding_number_unique" ON "contracts" ("holding_id", "contract_number") WHERE "deleted_at" IS NULL`
		);
		await queryRunner.query(`DROP INDEX IF EXISTS "contracts_holding_number_unique_ci"`);
	}
}
