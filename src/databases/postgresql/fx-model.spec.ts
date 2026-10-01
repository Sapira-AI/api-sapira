import * as fs from 'fs';
import * as path from 'path';

import { QueryRunner } from 'typeorm';

import { AddFxRatePurposeAndCompanyFxPolicy1790610000000 } from './migrations/1790610000000-AddFxRatePurposeAndCompanyFxPolicy';
import { FixHankaCompanyFxRatesDirection1790610000001 } from './migrations/1790610000001-FixHankaCompanyFxRatesDirection';
import { FixHankaCompanyFxRatesDirectionTrimmedName1790610000002 } from './migrations/1790610000002-FixHankaCompanyFxRatesDirectionTrimmedName';
import { MulticurrencyContract1790700000000 } from './migrations/1790700000000-MulticurrencyContract';

/**
 * Modelo FX de contratos v2 (28-09-2026): regla única "1 [from] = rate [to]" y `contract_fx_period_rates.purpose`.
 * Verifica los assets que leen la tabla y las dos migraciones (esquema y corrección de Hanka) sin abrir conexión.
 */
const asset = (name: string) => fs.readFileSync(path.join(__dirname, 'functions', `${name}.sql`), 'utf8');

describe('assets FX: purpose y dirección', () => {
	it('revenue_schedule_apply_fx_for_contract: fixed_period directo multiplica, inverso divide, solo purpose company', () => {
		const sql = asset('revenue_schedule_apply_fx_for_contract');
		const fixedBranch = sql.slice(
			sql.indexOf('LEFT JOIN contract_fx_period_rates cpr_direct') - 900,
			sql.indexOf(`v_info.fx_company_policy = 'fixed_period'`)
		);

		expect(fixedBranch).toContain('CASE WHEN cpr_direct.rate > 0 THEN cpr_direct.rate END');
		expect(fixedBranch).toContain('CASE WHEN cpr_inverse.rate > 0 THEN ROUND(1.0 / cpr_inverse.rate, 10) ELSE 1.0 END');
		expect(fixedBranch).not.toContain('1.0 / cpr_direct.rate');
		expect(sql).toContain(`AND cpr_direct.purpose = 'company'`);
		expect(sql).toContain(`AND cpr_inverse.purpose = 'company'`);
		// La marca con la que la migración de Hanka reconoce el asset nuevo.
		expect(sql).toContain(FixHankaCompanyFxRatesDirection1790610000001.RSM_MARKER);
		// Firma sin cambios.
		expect(sql).toContain('revenue_schedule_apply_fx_for_contract(p_contract_id uuid, p_from_month date DEFAULT NULL::date)');
		// Las tasas del holding (sistema) mantienen su convención.
		expect(sql).toContain('CASE WHEN hpr_direct.rate > 0 THEN ROUND(1.0 / hpr_direct.rate, 10) ELSE 1.0 END');
	});

	it('calculate_contract_fx_rate y bulk_confirm_fx_policy leen solo tasas de la compañía', () => {
		const calculate = asset('calculate_contract_fx_rate');

		expect(
			calculate.match(/FROM contract_fx_period_rates cfpr\s+WHERE cfpr\.contract_id = p_contract_id\s+AND cfpr\.purpose = 'company'/g)
		).toHaveLength(2);
		expect(asset('bulk_confirm_fx_policy')).toMatch(
			/FROM public\.contract_fx_period_rates\s+WHERE contract_id = v_cid\s+AND purpose = 'company'/
		);
	});

	it('ningún otro asset lee contract_fx_period_rates sin conocer purpose', () => {
		const functionsDir = path.join(__dirname, 'functions');
		const readers = fs
			.readdirSync(functionsDir)
			.filter((file) => fs.readFileSync(path.join(functionsDir, file), 'utf8').includes('contract_fx_period_rates'))
			.sort();

		expect(readers).toEqual([
			'bulk_confirm_fx_policy.sql',
			'calculate_contract_fx_rate.sql',
			'contract_item_fx_rate.sql',
			'revenue_schedule_apply_fx_for_contract.sql',
		]);
	});

	it('contract_item_fx_rate (multimoneda): solo purpose item, directa o 1/inversa, misma moneda 1 y sin fila NULL (nunca 1)', () => {
		const sql = asset('contract_item_fx_rate');

		expect(sql.match(/r\.purpose = 'item'/g)).toHaveLength(2);
		expect(sql).toContain(`IF p_from IS NULL OR p_to IS NULL OR UPPER(TRIM(p_from)) = UPPER(TRIM(p_to)) THEN RETURN 1; END IF;`);
		// Inversa a 6 decimales, igual que findFixedRate del motor TS (MRR/TCV de la API = RSM).
		expect(sql).toContain('SELECT ROUND(1.0 / r.rate, 6) INTO v_rate');
		expect(sql).toContain('r.period_start <= p_month_end AND r.period_end >= p_month_start');
		expect(sql).toContain('RETURN v_rate;');
	});

	it('revenue_schedule_rebuild_contract_ccy (multimoneda): montos del ítem × tasa item; sin tasa NULL + missing_fx_rate', () => {
		const sql = asset('revenue_schedule_rebuild_contract_ccy');

		expect(sql).toContain('v_item_ccy := UPPER(TRIM(COALESCE(v_item.currency, v_contract.contract_currency)));');
		expect(sql).toContain(
			'v_item_rate := public.contract_item_fx_rate(p_contract_id, v_item_ccy, v_contract.contract_currency, v_cur, v_eom_of_cur);'
		);
		expect(sql).toContain(`WHEN v_item_rate IS NULL THEN 'missing_fx_rate'`);
		for (const amount of ['v_recognized_period', 'v_billed_period', 'v_billed_cum', 'v_mrr_contracted', 'v_cmrr'])
			expect(sql).toContain(`ROUND(${amount} * v_item_rate, 2)`);
		// Lo facturado se lee igual (en moneda del ítem) y se convierte al escribir: nunca 1 por defecto.
		expect(sql).toContain('SELECT COALESCE(SUM(ii.subtotal_contract_currency), 0) INTO v_billed_period');
		expect(sql).not.toMatch(/COALESCE\(v_item_rate, 1\)/);
		// Ítems en la moneda del contrato: misma versión de cálculo que antes.
		expect(sql).toContain(`ELSE 'v3.2-nc-discount-2026-07' END;`);
	});

	it('sin vueltas (01-10): ítem en la moneda de la compañía o del sistema → esas columnas con el monto del ítem, también sin tasa item', () => {
		const sql = asset('revenue_schedule_rebuild_contract_ccy');

		// Directo solo si el ítem está en otra moneda que la del contrato y es la de la compañía / del sistema.
		expect(sql).toContain(`v_company_direct := CASE WHEN v_item_ccy IS DISTINCT FROM UPPER(TRIM(v_contract.contract_currency))
      AND v_item_ccy = UPPER(TRIM(v_contract.company_currency)) THEN 1 ELSE 0 END;`);
		expect(sql).toContain(`v_system_direct := CASE WHEN v_item_ccy IS DISTINCT FROM UPPER(TRIM(v_contract.contract_currency))
      AND v_item_ccy = UPPER(TRIM(v_contract.system_currency)) THEN 1 ELSE 0 END;`);
		// Columnas directas: los montos en moneda del ítem (sin × v_item_rate, así se llenan aunque falte la tasa y sin redondeo a contrato).
		for (const factor of ['v_company_direct', 'v_system_direct']) {
			for (const amount of ['v_recognized_period', 'v_recognized_cum', 'v_billed_period', 'v_billed_cum', 'v_mrr_contracted', 'v_cmrr'])
				expect(sql).toContain(`${amount} * ${factor}`);
			expect(sql).toContain(`v_monthly_price_item * ${factor}`);
			expect(sql).toContain(`-v_monthly_price_item * ${factor}`);
			expect(sql).not.toMatch(new RegExp(`v_item_rate[^,\\n]*\\* ${factor}`));
		}
		expect(sql).toContain(`CASE WHEN v_company_direct = 1 THEN 'item_currency_direct' END`);
		expect(sql).toContain('CASE WHEN v_company_direct = 1 THEN ROUND(1.0 / NULLIF(v_item_rate, 0), 10) ELSE 1 END');
		// La cola BOP/CHURN convierte a contrato desde el precio en moneda del ítem (que se conserva para las columnas directas).
		expect(sql).toContain('v_monthly_price := ROUND(v_monthly_price_item * v_item_rate, 2);');
		expect(sql).toContain('mrr_period_ccy                     = EXCLUDED.mrr_period_ccy,');
	});

	it('sin vueltas (01-10): apply_fx no pisa las columnas directas y conserva missing_fx_rate', () => {
		const sql = asset('revenue_schedule_apply_fx_for_contract');

		expect(sql).toContain(
			`COALESCE(array_agg(ci.id) FILTER (WHERE UPPER(TRIM(ci.currency)) = UPPER(TRIM(v_info.company_currency))), '{}'::uuid[])`
		);
		expect(sql).toContain('AND UPPER(TRIM(ci.currency)) <> UPPER(TRIM(v_info.contract_currency));');
		const company = [
			'recognized_period_ccy',
			'recognized_cum_ccy',
			'billed_period_ccy',
			'billed_cum_ccy',
			'deferred_balance_period_ccy',
			'unbilled_balance_period_ccy',
			'deferred_balance_eom_ccy',
			'unbilled_balance_eom_ccy',
			'mrr_period_ccy',
			'mrr_period_contracted_ccy',
			'cmrr_period_ccy',
			'fx_contract_to_company',
			'fx_to_company_source',
			'fx_to_company_date',
		];

		for (const column of company) {
			expect(sql).toMatch(
				new RegExp(`\\n\\s+${column}\\s+= CASE WHEN r\\.contract_item_id = ANY\\(v_company_direct_items\\) THEN r\\.${column} ELSE`)
			);
			const system = column.replace(/_ccy$/, '_system_ccy').replace('company', 'system');

			expect(sql).toMatch(
				new RegExp(`\\n\\s+${system}\\s+= CASE WHEN r\\.contract_item_id = ANY\\(v_system_direct_items\\) THEN r\\.${system} ELSE`)
			);
		}
		// Ninguna columna de compañía/sistema se escribe sin pasar por el filtro de directos.
		expect(sql.match(/= ROUND\(r\.\w+_contract_ccy \* COALESCE\(f[cs]\.rate, 1\.0\), 2\),/g)).toBeNull();
		expect(sql).toContain(
			`calc_version                        = CASE WHEN r.calc_version = 'missing_fx_rate' THEN r.calc_version ELSE 'v4-fx-normalized' END`
		);
	});
});

describe('migración 1790700000000 (multimoneda: purpose item)', () => {
	it('up: CHECK con item + comentario; down se niega si hay tasas item y si no, restaura el CHECK de dos valores', async () => {
		const { runner: up, query } = runner(() => undefined);

		await new MulticurrencyContract1790700000000().up(up);
		const statements = sqls(query);

		expect(statements[0]).toBe(`ALTER TABLE "contract_fx_period_rates" DROP CONSTRAINT "contract_fx_period_rates_purpose_check"`);
		expect(statements[1]).toContain(`CHECK (purpose = ANY (ARRAY['company'::text, 'invoice'::text, 'item'::text]))`);
		// Transición: apaga el job pg_cron legacy (un `cron.unschedule` va en migración, nunca en un asset de cron/).
		expect(statements[2]).toContain(`PERFORM cron.unschedule('auto-renew-contract-items')`);
		expect(statements[2]).toContain(`IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'auto-renew-contract-items')`);
		expect(statements[3]).toContain(`COMMENT ON COLUMN "contract_fx_period_rates"."purpose"`);
		expect(statements[3]).toContain('item (tasa fija pactada moneda del ítem → contrato');
		expect(statements.join('\n')).not.toMatch(/ADD "|DROP COLUMN|CREATE INDEX/);

		const blocked = runner((sql) => (sql.includes(`"purpose" = 'item'`) ? [{ count: 3 }] : undefined));

		await expect(new MulticurrencyContract1790700000000().down(blocked.runner)).rejects.toThrow('hay 3 tasas ítem → contrato');
		expect(sqls(blocked.query).some((sql) => sql.includes('DROP'))).toBe(false);

		const free = runner((sql) => (sql.includes(`"purpose" = 'item'`) ? [{ count: 0 }] : undefined));

		await new MulticurrencyContract1790700000000().down(free.runner);
		const reverted = sqls(free.query).join('\n');

		expect(reverted).toContain(`CHECK (purpose = ANY (ARRAY['company'::text, 'invoice'::text]))`);
		expect(reverted).not.toContain(`'item'::text`);
	});
});

const runner = (handler: (sql: string, params?: unknown[]) => unknown) => {
	const query = jest.fn(async (sql: string, params?: unknown[]) => handler(sql, params) ?? []);

	return { runner: { query } as unknown as QueryRunner, query };
};
const sqls = (query: jest.Mock) => query.mock.calls.map(([sql]) => sql as string);

describe('migración 1790610000000 (purpose + companies.fx_company_policy)', () => {
	it('up: columnas con default, CHECK e índice; down se niega si hay tasas de facturación', async () => {
		const { runner: up, query } = runner(() => undefined);

		await new AddFxRatePurposeAndCompanyFxPolicy1790610000000().up(up);
		const statements = sqls(query).join('\n');

		expect(statements).toContain(`ALTER TABLE "contract_fx_period_rates" ADD "purpose" text NOT NULL DEFAULT 'company'`);
		expect(statements).toContain(`CHECK (purpose = ANY (ARRAY['company'::text, 'invoice'::text]))`);
		expect(statements).toContain(
			`CREATE INDEX "idx_contract_fx_rates_contract_purpose" ON "contract_fx_period_rates" ("contract_id", "purpose")`
		);
		expect(statements).toContain(`ALTER TABLE "companies" ADD "fx_company_policy" text NOT NULL DEFAULT 'monthly_avg'`);
		expect(statements).toContain(`CHECK (fx_company_policy = ANY (ARRAY['monthly_avg'::text]))`);

		const blocked = runner((sql) => (sql.includes(`"purpose" = 'invoice'`) ? [{ count: 2 }] : undefined));

		await expect(new AddFxRatePurposeAndCompanyFxPolicy1790610000000().down(blocked.runner)).rejects.toThrow('hay 2 tasas de facturación');
		expect(sqls(blocked.query).some((sql) => sql.includes('DROP'))).toBe(false);

		const free = runner((sql) => (sql.includes(`"purpose" = 'invoice'`) ? [{ count: 0 }] : undefined));

		await new AddFxRatePurposeAndCompanyFxPolicy1790610000000().down(free.runner);
		expect(sqls(free.query).filter((sql) => sql.includes('DROP'))).toHaveLength(5);
	});
});

describe('migración 1790610000002 (Hanka, nombre del holding con espacio final)', () => {
	// En producción el holding se llama "Hanka Robotics " (espacio final): la 1790610000001 comparó exacto y no corrigió nada.
	const NEW_FUNCTION = `... AND cpr_direct.purpose = 'company' ...`;
	const rows = [{ id: 'r1', contract_id: 'c1' }];

	it('busca el holding con btrim y corrige + reconstruye como la anterior', async () => {
		const { runner: db, query } = runner((sql) => {
			if (sql.includes('pg_get_functiondef')) return [{ definition: NEW_FUNCTION }];
			if (sql.includes('SELECT r.id, r.contract_id')) return rows;

			return undefined;
		});

		await new FixHankaCompanyFxRatesDirectionTrimmedName1790610000002().up(db);
		const [selectSql, selectParams] = query.mock.calls.find(([sql]) => (sql as string).includes('SELECT r.id, r.contract_id'))!;

		expect(selectSql).toContain('btrim(h.name) = $1');
		expect((selectParams as unknown[])[0]).toBe('Hanka Robotics');
		expect(sqls(query).some((sql) => sql.includes('UPDATE contract_fx_period_rates'))).toBe(true);
		expect(query.mock.calls.filter(([sql]) => (sql as string).includes('revenue_schedule_rebuild')).map(([, params]) => params)).toEqual([
			['c1'],
		]);
	});

	it('sin el asset nuevo aplicado, aborta', async () => {
		const { runner: db } = runner((sql) =>
			sql.includes('pg_get_functiondef') ? [{ definition: 'ROUND(1.0 / cpr_direct.rate, 10)' }] : undefined
		);

		await expect(new FixHankaCompanyFxRatesDirectionTrimmedName1790610000002().up(db)).rejects.toThrow('Aplica primero el asset');
	});
});

describe('migración 1790610000001 (Hanka: 0.000025 → 40.000)', () => {
	const NEW_FUNCTION = `... AND cpr_direct.purpose = 'company' ...`;
	const OLD_FUNCTION = `... ROUND(1.0 / cpr_direct.rate, 10) ...`;
	const migration = () => new FixHankaCompanyFxRatesDirection1790610000001();
	const rows = [
		{ id: 'r1', contract_id: 'c1' },
		{ id: 'r2', contract_id: 'c1' },
		{ id: 'r3', contract_id: 'c2' },
		{ id: 'r4', contract_id: 'c3' },
		{ id: 'r5', contract_id: 'c4' },
	];

	it('sin el asset nuevo aplicado, aborta sin tocar nada', async () => {
		const { runner: db, query } = runner((sql) => (sql.includes('pg_get_functiondef') ? [{ definition: OLD_FUNCTION }] : undefined));

		await expect(migration().up(db)).rejects.toThrow('Aplica primero el asset');
		expect(sqls(query).some((sql) => sql.includes('UPDATE contract_fx_period_rates'))).toBe(false);
	});

	it('corrige solo las filas del alcance (idempotente) y reconstruye el RSM de cada contrato', async () => {
		const { runner: db, query } = runner((sql) => {
			if (sql.includes('pg_get_functiondef')) return [{ definition: NEW_FUNCTION }];
			if (sql.includes('SELECT r.id, r.contract_id')) return rows;

			return undefined;
		});

		await migration().up(db);
		const [selectSql, selectParams] = query.mock.calls.find(([sql]) => (sql as string).includes('SELECT r.id, r.contract_id'))!;

		expect(selectSql).toContain('h.name = $1 AND c.contract_number = ANY($2::text[])');
		expect(selectSql).toContain(`r.rate = $5::numeric AND r.purpose = 'company'`);
		expect(selectParams).toEqual(['Hanka Robotics', ['CTR-2025-004', 'CTR-2025-007', 'CTR-2025-009', 'CTR-2026-007'], 'CLF', 'CLP', '0.000025']);
		expect((selectParams as unknown[])[1]).not.toContain('CTR-2026-215');

		const [, updateParams] = query.mock.calls.find(([sql]) => (sql as string).includes('UPDATE contract_fx_period_rates'))!;

		expect((updateParams as unknown[]).slice(0, 2)).toEqual([['r1', 'r2', 'r3', 'r4', 'r5'], '40000']);
		const rebuilds = query.mock.calls.filter(([sql]) => (sql as string).includes('revenue_schedule_rebuild'));

		expect(rebuilds.map(([, params]) => params)).toEqual([['c1'], ['c2'], ['c3'], ['c4']]);
		expect(sqls(query).findIndex((sql) => sql.includes('UPDATE contract_fx_period_rates'))).toBeLessThan(
			sqls(query).findIndex((sql) => sql.includes('revenue_schedule_rebuild'))
		);
	});

	it('sin filas (QA o ya corregido) no escribe; con más de 5 aborta', async () => {
		const none = runner((sql) => (sql.includes('pg_get_functiondef') ? [{ definition: NEW_FUNCTION }] : undefined));

		await migration().up(none.runner);
		expect(sqls(none.query).some((sql) => sql.includes('UPDATE contract_fx_period_rates') || sql.includes('revenue_schedule_rebuild'))).toBe(
			false
		);

		const many = runner((sql) => {
			if (sql.includes('pg_get_functiondef')) return [{ definition: NEW_FUNCTION }];
			if (sql.includes('SELECT r.id, r.contract_id')) return [...rows, { id: 'r6', contract_id: 'c5' }];

			return undefined;
		});

		await expect(migration().up(many.runner)).rejects.toThrow('como máximo 5');
	});

	it('down exige el asset viejo y devuelve 40.000 → 0.000025 solo en las filas marcadas', async () => {
		const blocked = runner((sql) => (sql.includes('pg_get_functiondef') ? [{ definition: NEW_FUNCTION }] : undefined));

		await expect(migration().down(blocked.runner)).rejects.toThrow('Revierte primero el asset');

		const { runner: db, query } = runner((sql) => {
			if (sql.includes('pg_get_functiondef')) return [{ definition: OLD_FUNCTION }];
			if (sql.includes('UPDATE contract_fx_period_rates')) return [{ contract_id: 'c1' }, { contract_id: 'c1' }, { contract_id: 'c2' }];

			return undefined;
		});

		await migration().down(db);
		const [updateSql, updateParams] = query.mock.calls.find(([sql]) => (sql as string).includes('UPDATE contract_fx_period_rates'))!;

		expect(updateSql).toContain(`r.notes LIKE '%' || $7::text || '%'`);
		expect((updateParams as unknown[]).slice(4, 6)).toEqual(['0.000025', '40000']);
		expect(query.mock.calls.filter(([sql]) => (sql as string).includes('revenue_schedule_rebuild'))).toHaveLength(2);
	});
});
