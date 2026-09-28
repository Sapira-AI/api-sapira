import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Repite `FixHankaCompanyFxRatesDirection1790610000001`, que en producción no corrigió ninguna fila: el holding se llama
 * `"Hanka Robotics "` (con espacio final) y la migración comparaba el nombre exacto. Mientras tanto el asset nuevo de
 * `revenue_schedule_apply_fx_for_contract` ya multiplica la tasa, así que hasta que estas 5 filas pasen de 0.000025 a
 * 40.000 cualquier `revenue_schedule_rebuild` de esos contratos dejaría el devengo en CLP mal (× 0.000025).
 *
 * Mismo alcance, misma guarda del asset y misma idempotencia que la anterior; solo cambia `btrim(h.name)`.
 */
const HANKA_FX_FIX = {
	holdingName: 'Hanka Robotics',
	contractNumbers: ['CTR-2025-004', 'CTR-2025-007', 'CTR-2025-009', 'CTR-2026-007'],
	fromCurrency: 'CLF',
	toCurrency: 'CLP',
	oldRate: '0.000025',
	newRate: '40000',
	expectedRows: 5,
	marker: '[v2] dirección corregida: era 0.000025 (1 CLP = 0.000025 CLF)',
} as const;

const NEW_RSM_FX_MARKER = `purpose = 'company'`;

export class FixHankaCompanyFxRatesDirectionTrimmedName1790610000002 implements MigrationInterface {
	name = 'FixHankaCompanyFxRatesDirectionTrimmedName1790610000002';
	static readonly SCOPE = HANKA_FX_FIX;

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
			WHERE btrim(h.name) = $1 AND c.contract_number = ANY($2::text[])
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
				AND btrim(h.name) = $1 AND c.contract_number = ANY($2::text[])
				AND r.from_currency = $3 AND r.to_currency = $4 AND r.rate = $6::numeric AND r.notes LIKE '%' || $7::text || '%'
			RETURNING r.contract_id`,
			[holdingName, contractNumbers, fromCurrency, toCurrency, oldRate, newRate, marker]
		)) as Array<{ contract_id: string }>;

		for (const contractId of [...new Set(rows.map((row) => row.contract_id))]) {
			await queryRunner.query(`SELECT revenue_schedule_rebuild($1::uuid, NULL::date)`, [contractId]);
		}
	}
}
