import { MigrationInterface, QueryRunner } from 'typeorm';

/** Alcance exacto de la corrección (producción). SimpliRoute CTR-2026-215 queda fuera a propósito: lo revisa Domi. */
const HANKA_FX_FIX = {
	holdingName: 'Hanka Robotics',
	contractNumbers: ['CTR-2025-004', 'CTR-2025-007', 'CTR-2025-009', 'CTR-2026-007'],
	fromCurrency: 'CLF',
	toCurrency: 'CLP',
	oldRate: '0.000025',
	newRate: '40000',
	/** Filas esperadas en producción (una de las 4 tiene dos períodos). */
	expectedRows: 5,
	marker: '[v2] dirección corregida: era 0.000025 (1 CLP = 0.000025 CLF)',
} as const;

/** El asset nuevo de `revenue_schedule_apply_fx_for_contract` filtra por purpose: así se reconoce que ya está aplicado. */
const NEW_RSM_FX_MARKER = `purpose = 'company'`;

/**
 * Corrección de datos (GUIA: "corregir filas existentes → migración con UPDATE") que acompaña al cambio de dirección de
 * `revenue_schedule_apply_fx_for_contract` en `fixed_period`.
 *
 * Las 5 tasas CLF → CLP de Hanka Robotics se cargaron como 0.000025 ("1 CLP = 0.000025 CLF") y el RSM viejo las invertía
 * (1 / 0.000025 = 40.000). Con la regla única "1 [from] = rate [to]" la fila directa se multiplica, así que la tasa
 * correcta es 40.000 y el devengo en CLP **no cambia**: viejo = 1/0.000025, nuevo = 40.000.
 *
 * Por eso solo corre con el asset nuevo ya aplicado (si no, el RSM leería 1/40.000): si el asset falta, aborta y la
 * migración queda pendiente (`migration:run` usa una transacción por migración). Después del UPDATE reconstruye el RSM
 * de esos contratos en la misma transacción.
 *
 * Idempotente: el WHERE exige holding, números de contrato, par CLF → CLP, `purpose = 'company'` y `rate = 0.000025`.
 * En una base sin esas filas (QA) no cambia nada.
 */
export class FixHankaCompanyFxRatesDirection1790610000001 implements MigrationInterface {
	name = 'FixHankaCompanyFxRatesDirection1790610000001';
	// Todo export de una migración debe ser su clase (lo exige schema-status.spec): el alcance se expone como estático.
	static readonly SCOPE = HANKA_FX_FIX;
	static readonly RSM_MARKER = NEW_RSM_FX_MARKER;

	private async rsmHasNewDirection(queryRunner: QueryRunner): Promise<boolean> {
		const [row] = (await queryRunner.query(
			`SELECT pg_get_functiondef('public.revenue_schedule_apply_fx_for_contract(uuid, date)'::regprocedure) AS definition`
		)) as Array<{ definition: string }>;

		return String(row?.definition ?? '').includes(NEW_RSM_FX_MARKER);
	}

	public async up(queryRunner: QueryRunner): Promise<void> {
		if (!(await this.rsmHasNewDirection(queryRunner))) {
			throw new Error(
				'Aplica primero el asset functions/revenue_schedule_apply_fx_for_contract.sql (dirección nueva de fixed_period): sin él, esta corrección cambiaría el devengo de Hanka.'
			);
		}

		const { holdingName, contractNumbers, fromCurrency, toCurrency, oldRate, newRate, expectedRows, marker } = HANKA_FX_FIX;
		const rows = (await queryRunner.query(
			`SELECT r.id, r.contract_id
			FROM contract_fx_period_rates r
			JOIN contracts c ON c.id = r.contract_id
			JOIN company_holdings h ON h.id = r.holding_id AND h.id = c.holding_id
			WHERE h.name = $1 AND c.contract_number = ANY($2::text[])
				AND r.from_currency = $3 AND r.to_currency = $4 AND r.rate = $5::numeric AND r.purpose = 'company'
			FOR UPDATE OF r`,
			[holdingName, contractNumbers, fromCurrency, toCurrency, oldRate]
		)) as Array<{ id: string; contract_id: string }>;

		if (rows.length > expectedRows) {
			throw new Error(`Se esperaban como máximo ${expectedRows} tasas de Hanka y hay ${rows.length}: revisar antes de corregir.`);
		}
		if (!rows.length) return;

		await queryRunner.query(
			`UPDATE contract_fx_period_rates
			SET rate = $2::numeric, notes = CONCAT_WS(' · ', NULLIF(notes, ''), $3::text)
			WHERE id = ANY($1::uuid[])`,
			[rows.map((row) => row.id), newRate, marker]
		);

		for (const contractId of [...new Set(rows.map((row) => row.contract_id))]) {
			await queryRunner.query(`SELECT revenue_schedule_rebuild($1::uuid, NULL::date)`, [contractId]);
		}
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		// Simétrico: con la dirección nueva del RSM, volver a 0.000025 cambiaría el devengo. Primero se revierte el asset.
		if (await this.rsmHasNewDirection(queryRunner)) {
			throw new Error(
				'Revierte primero el asset functions/revenue_schedule_apply_fx_for_contract.sql a la dirección vieja: con la nueva, volver a 0.000025 cambiaría el devengo de Hanka.'
			);
		}

		const { holdingName, contractNumbers, fromCurrency, toCurrency, oldRate, newRate, marker } = HANKA_FX_FIX;
		const rows = (await queryRunner.query(
			`UPDATE contract_fx_period_rates r
			SET rate = $5::numeric, notes = NULLIF(TRIM(BOTH ' ·' FROM REPLACE(COALESCE(r.notes, ''), $7::text, '')), '')
			FROM contracts c, company_holdings h
			WHERE c.id = r.contract_id AND h.id = r.holding_id AND h.id = c.holding_id
				AND h.name = $1 AND c.contract_number = ANY($2::text[])
				AND r.from_currency = $3 AND r.to_currency = $4 AND r.rate = $6::numeric AND r.notes LIKE '%' || $7::text || '%'
			RETURNING r.contract_id`,
			[holdingName, contractNumbers, fromCurrency, toCurrency, oldRate, newRate, marker]
		)) as Array<{ contract_id: string }>;

		for (const contractId of [...new Set(rows.map((row) => row.contract_id))]) {
			await queryRunner.query(`SELECT revenue_schedule_rebuild($1::uuid, NULL::date)`, [contractId]);
		}
	}
}
