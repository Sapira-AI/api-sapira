import * as fs from 'fs';
import * as path from 'path';

import { QueryRunner } from 'typeorm';

import { BACKUP_SCHEMA } from './backups';
import { AddFxRatePurposeAndCompanyFxPolicy1790610000000 } from './migrations/1790610000000-AddFxRatePurposeAndCompanyFxPolicy';
import { FixHankaCompanyFxRatesDirection1790610000001 } from './migrations/1790610000001-FixHankaCompanyFxRatesDirection';
import { FixHankaCompanyFxRatesDirectionTrimmedName1790610000002 } from './migrations/1790610000002-FixHankaCompanyFxRatesDirectionTrimmedName';
import { MulticurrencyContract1790700000000 } from './migrations/1790700000000-MulticurrencyContract';
import { InvoiceSystemAmountsFromInvoiceCurrency1791200000000 } from './migrations/1791200000000-InvoiceSystemAmountsFromInvoiceCurrency';
import { LimpiaPromediosMensualesManuales1791500000000 } from './migrations/1791500000000-LimpiaPromediosMensualesManuales';

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
		expect(fixedBranch).toContain('CASE WHEN cpr_inverse.rate > 0 THEN ROUND(1.0 / cpr_inverse.rate, 10) END');
		expect(fixedBranch).not.toContain('1.0 / cpr_direct.rate');
		expect(sql).toContain(`AND cpr_direct.purpose = 'company'`);
		expect(sql).toContain(`AND cpr_inverse.purpose = 'company'`);
		// La marca con la que la migración de Hanka reconoce el asset nuevo.
		expect(sql).toContain(FixHankaCompanyFxRatesDirection1790610000001.RSM_MARKER);
		// Firma sin cambios.
		expect(sql).toContain('revenue_schedule_apply_fx_for_contract(p_contract_id uuid, p_from_month date DEFAULT NULL::date)');
		// Las tasas del holding (sistema) mantienen su convención (directa 1/rate, inversa rate), sin 1,0 de relleno (S5-10), y salen de
		// holding_fixed_fx_rate (tasa proyectada, 04-10).
		expect(sql).toContain('CASE WHEN hpr.rate > 0 THEN CASE WHEN hpr.is_inverse THEN hpr.rate ELSE ROUND(1.0 / hpr.rate, 10) END END AS rate');
		expect(sql).toContain(
			'LEFT JOIN LATERAL public.holding_fixed_fx_rate(v_info.holding_id, v_info.contract_currency, v_info.system_currency, rsm.period_month::date) hpr ON true'
		);
		expect(sql).toContain(`WHEN hpr.rate IS NULL THEN 'missing_fx_rate'`);
		expect(sql).not.toContain('LEFT JOIN holding_fx_period_rates');
	});

	it('holding_fixed_fx_rate (tasa proyectada, 04-10): cubre → directa o inversa; después de la última tasa del par → la última, projected', () => {
		const sql = asset('holding_fixed_fx_rate');

		expect(sql).toContain(
			'holding_fixed_fx_rate(p_holding_id uuid, p_from text, p_to text, p_date date)\n RETURNS TABLE(rate numeric, is_inverse boolean, period_start date, period_end date, projected boolean)'
		);
		// Orden: directa que cubre, inversa que cubre, proyectada.
		const direct = sql.indexOf('r.from_currency = p_from AND r.to_currency = p_to\n    AND p_date BETWEEN');
		const inverse = sql.indexOf('r.from_currency = p_to AND r.to_currency = p_from\n    AND p_date BETWEEN');
		const projected = sql.indexOf('SELECT last.rate, last.is_inverse, last.period_start, last.period_end, true');

		expect(direct).toBeGreaterThan(0);
		expect(inverse).toBeGreaterThan(direct);
		expect(projected).toBeGreaterThan(inverse);
		// Solo hacia adelante: la última tasa del par (mayor fin, en cualquier sentido) tiene que terminar antes de la fecha; un hueco no se proyecta.
		expect(sql).toContain('ORDER BY r.period_end DESC, (r.from_currency = p_to), r.created_at DESC NULLS LAST');
		expect(sql).toContain('WHERE last.period_end < p_date;');
		expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/);
	});

	it('holding_fixed_fx_rate: la proyección aplica solo a meses posteriores al mes en curso del holding; pasado o actual sin tasa → sin filas', () => {
		const sql = asset('holding_fixed_fx_rate');
		const flat = sql.replace(/\s+/g, ' ');

		// Mes en curso = el del "hoy" del holding (holding_settings.timezone, default America/Santiago), no CURRENT_DATE (UTC).
		expect(flat).toContain(
			"SELECT (DATE_TRUNC('month', now() AT TIME ZONE COALESCE( (SELECT hs.timezone FROM holding_settings hs WHERE hs.holding_id = p_holding_id LIMIT 1), 'America/Santiago')) + INTERVAL '1 month')::date INTO v_next_month;"
		);
		expect(flat).toContain('IF p_date < v_next_month THEN RETURN; END IF;');
		expect(flat).not.toMatch(/(?<!-- )CURRENT_DATE (?!de la sesión)/);
		// El corte va después de las tasas que cubren la fecha (un mes pasado con tasa registrada la sigue usando) y antes de la proyección.
		const cut = sql.indexOf('IF p_date < v_next_month THEN');

		expect(cut).toBeGreaterThan(sql.indexOf('r.from_currency = p_to AND r.to_currency = p_from\n    AND p_date BETWEEN'));
		expect(cut).toBeLessThan(sql.indexOf('SELECT last.rate, last.is_inverse, last.period_start, last.period_end, true'));
	});

	it('calculate_system_fx_rate (facturas) usa la misma búsqueda y conserva su sentido (directa rate, inversa 1/rate a 6 decimales)', () => {
		const sql = asset('calculate_system_fx_rate');

		expect(sql).toContain('FROM public.holding_fixed_fx_rate(p_holding_id, p_from_currency, p_to_currency, p_period_date) h;');
		expect(sql).toContain('CASE WHEN h.is_inverse THEN ROUND(1.0 / h.rate, 6) ELSE h.rate END');
		expect(sql).toContain(`v_source := 'missing_holding_fx_rate';`);
		expect(sql).not.toContain('FROM holding_fx_period_rates');
	});

	it('auto_populate_invoice_fx_to_system (04-10): regla por estado (documento → neto en moneda de factura; Por Emitir → encabezado)', () => {
		const sql = asset('auto_populate_invoice_fx_to_system');

		expect(sql).toContain(`IF NEW.status IS DISTINCT FROM 'Por Emitir'
     AND NEW.amount_invoice_currency IS NOT NULL AND NULLIF(TRIM(NEW.invoice_currency), '') IS NOT NULL
     AND (NEW.amount_invoice_currency <> 0 OR COALESCE(NEW.amount_contract_currency, 0) = 0) THEN`);
		// La guarda de la migración reconoce este asset.
		expect(sql).toContain(InvoiceSystemAmountsFromInvoiceCurrency1791200000000.TRIGGER_MARKER);
		expect(sql).toContain('v_contract_currency := UPPER(TRIM(NEW.invoice_currency));');
		expect(sql).toContain('v_source_amount := NEW.amount_invoice_currency;');
		// Respaldo: moneda del encabezado (unificadas mixtas) y monto en contrato.
		expect(sql).toContain(`SELECT UPPER(TRIM(COALESCE(NULLIF(TRIM(NEW.contract_currency), ''), c.contract_currency))) INTO v_contract_currency`);
		expect(sql).toContain('v_source_amount := NEW.amount_contract_currency;');
		expect(sql).toContain('NEW.amount_system_currency := v_source_amount;');
		expect(sql).toContain('NEW.amount_system_currency := ROUND(v_source_amount / NULLIF(v_fx_result.rate, 0), 2);');
		expect(sql).not.toContain('NEW.amount_contract_currency / NULLIF');
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
		expect(sql).toContain(`WHEN r.calc_version = 'missing_fx_rate' AND r.recognized_cum_contract_ccy IS NULL THEN r.calc_version`);
	});

	it('S5-10 (01-10): sin tasa compañía/sistema nunca 1,0 → columnas NULL, fuente y calc_version missing_fx_rate; directas intactas', () => {
		const sql = asset('revenue_schedule_apply_fx_for_contract');

		// Ninguna rama de tasa ni el UPDATE rellenan con 1,0 (la única tasa 1 es la de misma moneda contrato = compañía / sistema).
		expect(sql).not.toMatch(/ELSE 1\.0 END/);
		expect(sql).not.toMatch(/COALESCE\(f[cs]\.rate, 1\.0\)/);
		expect(sql.match(/SELECT rsm\.period_month, 1\.0::numeric AS rate, NULL::text AS src/g)).toHaveLength(2);
		// Promedio mensual: directa o 1/inversa, NULL sin ninguna (compañía y sistema; en compañía, además, solo meses terminados).
		expect(
			sql.match(
				/COALESCE\(\s+CASE WHEN ema_direct\.avg_rate > 0 THEN ema_direct\.avg_rate END,\s+CASE WHEN ema_inverse\.avg_rate > 0 THEN ROUND\(1\.0 \/ ema_inverse\.avg_rate, 6\) END\s+\)/g
			)
		).toHaveLength(2);
		// Columnas convertidas = monto de contrato × tasa (NULL × … = NULL); fx_contract_to_* = la tasa (NULL sin tasa).
		for (const [prefix, alias, list] of [
			['', 'fc', 'v_company_direct_items'],
			['_system', 'fs', 'v_system_direct_items'],
		] as const) {
			for (const amount of ['recognized_period', 'recognized_cum', 'billed_period', 'deferred_balance_eom', 'mrr_period', 'cmrr_period'])
				expect(sql).toContain(`ELSE ROUND(r.${amount}_contract_ccy * ${alias}.rate, 2) END`);
			// Compañía: el mes sin cerrar (pending_month_close, Domi 04-10) conserva su fuente y no es missing_fx_rate.
			const pending = alias === 'fc' ? `CASE WHEN fc.src = 'pending_month_close' THEN fc.src ELSE 'missing_fx_rate' END` : `'missing_fx_rate'`;
			const notPending = alias === 'fc' ? ` AND COALESCE(fc.src, '') <> 'pending_month_close'` : '';

			expect(sql).toContain(`ELSE CASE WHEN ${alias}.rate IS NULL THEN ${pending} ELSE COALESCE(${alias}.src, 'no_conversion_needed') END END`);
			expect(sql).toContain(
				`WHEN ${alias}.rate IS NULL${notPending} AND NOT COALESCE(r.contract_item_id = ANY(${list}), false) THEN 'missing_fx_rate'`
			);
			expect(sql).toMatch(new RegExp(`recognized_period${prefix}_ccy\\s+= CASE WHEN r\\.contract_item_id = ANY\\(${list}\\)`));
		}
		expect(sql).toContain(
			`fx_contract_to_company          = CASE WHEN r.contract_item_id = ANY(v_company_direct_items) THEN r.fx_contract_to_company ELSE fc.rate END`
		);
		expect(sql).toContain(
			`fx_contract_to_system               = CASE WHEN r.contract_item_id = ANY(v_system_direct_items) THEN r.fx_contract_to_system ELSE fs.rate END`
		);
		expect(sql).toContain(`ELSE 'v4-fx-normalized' END`);
		expect(sql).toMatch(/END;\n\$function\$;\n\nCOMMENT ON FUNCTION/);
	});
});

describe('moneda de compañía solo en meses terminados con promedio cerrado (Domi 04-10)', () => {
	const sql = asset('revenue_schedule_apply_fx_for_contract');
	const companyAvg = sql.slice(sql.indexOf('-- Promedio mensual (Domi 04-10)'), sql.indexOf(`AND v_info.fx_company_policy = 'monthly_avg'`));

	it('mes en curso del holding (timezone, default America/Santiago), no CURRENT_DATE de la sesión', () => {
		expect(sql).toContain(`COALESCE(NULLIF(TRIM(hs.timezone), ''), 'America/Santiago') AS timezone`);
		expect(sql).toContain(`v_current_month := (DATE_TRUNC('month', now() AT TIME ZONE v_info.timezone))::date;`);
		// Fuera de comentarios, nunca CURRENT_DATE (UTC en Supabase).
		expect(sql).not.toMatch(/^[^-\n]*CURRENT_DATE/m);
	});

	it('promedio mensual: tasa solo si el mes terminó; en curso y futuros pending_month_close; el recién terminado sin cierre también', () => {
		expect(companyAvg).toContain('CASE WHEN rsm.period_month < v_current_month THEN');
		expect(companyAvg).toContain(`WHEN rsm.period_month >= v_current_month THEN 'pending_month_close'`);
		expect(companyAvg).toContain(`WHEN rsm.period_month = (v_current_month - INTERVAL '1 month')::date THEN 'pending_month_close'`);
		// El orden importa: primero el mes no terminado, después las tasas, al final el hueco.
		expect(companyAvg.indexOf(`>= v_current_month THEN 'pending_month_close'`)).toBeLessThan(companyAvg.indexOf(`THEN 'monthly_average'`));
		expect(companyAvg.indexOf(`(v_current_month - INTERVAL '1 month')`)).toBeGreaterThan(companyAvg.indexOf(`THEN 'monthly_average_inverse'`));
	});

	it('promedio cerrado: recalculado después de terminar el mes y armado con tasas diarias (directo e inverso)', () => {
		for (const alias of ['ema_direct', 'ema_inverse']) {
			expect(companyAvg).toContain(`AND ${alias}.data_points > 1`);
			expect(companyAvg).toContain(
				`AND ${alias}.calculated_at >= ((rsm.period_month::date + INTERVAL '1 month')::timestamp AT TIME ZONE v_info.timezone)`
			);
		}
		// La moneda de sistema no cambia: su promedio no exige cierre.
		const systemAvg = sql.slice(sql.indexOf('fx_system AS ('), sql.indexOf(`AND v_info.fx_system_policy = 'monthly_avg'`));

		expect(systemAvg).not.toContain('data_points');
		expect(systemAvg).not.toContain('v_current_month');
	});

	it('la política fija del contrato se llena siempre (sin condición de mes)', () => {
		const fixed = sql.slice(
			sql.indexOf('LEFT JOIN contract_fx_period_rates cpr_direct') - 900,
			sql.indexOf(`v_info.fx_company_policy = 'fixed_period'`)
		);

		expect(fixed).not.toContain('v_current_month');
		expect(fixed).not.toContain('pending_month_close');
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

describe('migración 1791200000000 (montos en moneda de sistema con la regla por estado, 04-10)', () => {
	const Migration = InvoiceSystemAmountsFromInvoiceCurrency1791200000000;
	const squash = (sql: string) => sql.replace(/\s+/g, ' ');

	it('alcance: documentos (ni Por Emitir ni Canceladas), neto en moneda de factura, sin meses cerrados, con tasa; fuera bruto como neto y monto sin convertir', () => {
		const sql = squash(Migration.INVOICES_SQL);

		expect(sql).toContain(`i.status IS DISTINCT FROM 'Por Emitir' AND i.status IS DISTINCT FROM 'Cancelada'`);
		expect(sql).toContain(`UPPER(TRIM(i.invoice_currency)) AS source_currency, i.amount_invoice_currency AS source_amount`);
		expect(sql).toContain('AND (i.amount_invoice_currency <> 0 OR COALESCE(i.amount_contract_currency, 0) = 0)');
		// Meses cerrados: desde el primer mes abierto de la compañía.
		expect(sql).toContain(
			`COALESCE(i.issue_date, i.scheduled_at, i.original_issue_date, CURRENT_DATE) >= COALESCE((date_trunc('month', public.get_cutoff_date(i.holding_id, i.company_id)) + interval '1 month')::date, '-infinity'::date)`
		);
		// Solo donde la conversión cambia: moneda de factura ≠ contrato, encabezado mixto, neto ≠ monto en contrato o líneas "sin vueltas".
		expect(sql).toContain('UPPER(TRIM(i.invoice_currency)) <> UPPER(TRIM(c.contract_currency))');
		expect(sql).toContain('ABS(i.amount_invoice_currency - COALESCE(i.amount_contract_currency, 0)) > 0.005');
		expect(sql).toContain('public.calculate_system_fx_rate(b.holding_id, b.source_currency, b.system_currency, b.fx_date, b.policy)');
		expect(sql).toContain(`CASE WHEN policy = 'fixed_period' THEN source_amount / NULLIF(rate, 0) ELSE source_amount * rate END`);
		expect(sql).toContain('FROM rated WHERE rate IS NOT NULL');
		expect(sql).toContain('ROUND(new_amount * (1 + tax_pct / 100.0), 2) AS new_total');
		expect(sql).toContain('AND i.amount_invoice_currency = i.total_invoice_currency');
		expect(sql).toContain('AND i.amount_invoice_currency = i.amount_contract_currency');
		// NC espejo: tasa efectiva de la original.
		const credit = squash(Migration.CREDIT_NOTES_SQL);

		expect(credit).toContain('n.amount_invoice_currency * o.amount_system_currency / o.amount_invoice_currency');
		expect(credit).toContain(`o.status IS DISTINCT FROM 'Por Emitir'`);
		expect(credit).toContain(`n.status IS DISTINCT FROM 'Cancelada'`);
		expect(credit).toContain(`b.invoice_id = o.id AND b.kind IN ('invoice', 'pending')`);
	});

	it('Por Emitir: solo las unificadas multimoneda (encabezado en otra moneda que el contrato), desde la moneda de contrato del encabezado', () => {
		const sql = squash(Migration.PENDING_SQL);

		expect(sql).toContain(`i.status = 'Por Emitir'`);
		expect(sql).toContain(
			`UPPER(TRIM(COALESCE(NULLIF(TRIM(i.contract_currency), ''), c.contract_currency))) AS source_currency, i.amount_contract_currency AS source_amount`
		);
		expect(sql).toContain(
			`AND UPPER(TRIM(COALESCE(NULLIF(TRIM(i.contract_currency), ''), c.contract_currency))) <> UPPER(TRIM(c.contract_currency))`
		);
		expect(sql).toContain(
			`COALESCE((date_trunc('month', public.get_cutoff_date(i.holding_id, i.company_id)) + interval '1 month')::date, '-infinity'::date)`
		);
	});

	it('sin el asset nuevo del trigger aborta sin escribir', async () => {
		const { runner: db, query } = runner((sql) =>
			sql.includes('pg_get_functiondef') ? [{ definition: 'SELECT contract_currency INTO v_contract_currency' }] : undefined
		);

		await expect(new Migration().up(db)).rejects.toThrow('Aplica primero el asset');
		expect(sqls(query).some((sql) => sql.includes('UPDATE invoices') || sql.includes('CREATE'))).toBe(false);
	});

	it('up: sapira.writer, respaldo fuera de public, facturas y después NC espejo; solo escribe los campos en moneda de sistema', async () => {
		const { runner: db, query } = runner((sql) =>
			sql.includes('pg_get_functiondef') ? [{ definition: `... ${Migration.TRIGGER_MARKER} ...` }] : undefined
		);

		await new Migration().up(db);
		const statements = sqls(query);
		const writer = statements.findIndex((sql) => sql.includes(`set_config('sapira.writer', 'api', true)`));
		const table = statements.findIndex((sql) => sql.includes(`CREATE TABLE IF NOT EXISTS ${Migration.BACKUP_TABLE}`));
		const updates = statements.map((sql, index) => [sql, index] as const).filter(([sql]) => sql.includes('UPDATE invoices i'));

		// El esquema del respaldo sale de una sola constante (`backups.ts`).
		expect(Migration.BACKUP_TABLE).toBe(`${BACKUP_SCHEMA}.invoice_system_fx_1791200000000`);
		expect(statements).toContain(`CREATE SCHEMA IF NOT EXISTS ${BACKUP_SCHEMA}`);
		expect(writer).toBeGreaterThan(0);
		expect(table).toBeGreaterThan(writer);
		expect(updates).toHaveLength(3);
		expect(updates[0][0]).toContain(`'invoice'`);
		expect(updates[1][0]).toContain(`'pending'`);
		expect(updates[2][0]).toContain(`'credit_note'`);
		expect(updates[0][1]).toBeGreaterThan(table);
		for (const [sql] of updates) {
			expect(sql).toContain('ON CONFLICT (invoice_id) DO NOTHING');
			expect(squash(sql)).toContain(
				'SET fx_contract_to_system = v.new_fx, system_currency = v.new_system_currency, amount_system_currency = v.new_amount, total_system_currency = v.new_total'
			);
			// El SET solo escribe los cuatro campos de sistema (el `status = 'Por Emitir'` del WHERE de las Por Emitir no cuenta).
			const set = squash(sql).split('UPDATE invoices i SET ')[1].split(' FROM v ')[0];

			expect(set).not.toMatch(/amount_contract_currency\s*=|amount_invoice_currency\s*=|invoice_number\s*=|status\s*=/);
		}
	});

	it('down: restaura solo las filas que siguen con los valores de la migración y borra el respaldo si no queda nada', async () => {
		const restored = runner((sql) => {
			if (sql.includes('to_regclass')) return [{ present: true }];
			if (sql.includes('count(*)::int')) return [{ n: 0 }];

			return undefined;
		});

		await new Migration().down(restored.runner);
		const statements = sqls(restored.query);
		const restore = statements.find((sql) => sql.includes('UPDATE invoices i'))!;

		expect(restore).toContain('i.total_system_currency IS NOT DISTINCT FROM b.new_total');
		expect(restore).toContain('amount_system_currency = b.old_amount');
		expect(statements).toContain(`DROP TABLE ${Migration.BACKUP_TABLE}`);
		// El esquema solo se borra si quedó vacío (otra migración puede tener su respaldo ahí).
		expect(statements.some((sql) => sql.includes(`DROP SCHEMA ${BACKUP_SCHEMA}`) && sql.includes('IF NOT EXISTS'))).toBe(true);

		const pending = runner((sql) => {
			if (sql.includes('to_regclass')) return [{ present: true }];
			if (sql.includes('count(*)::int')) return [{ n: 3 }];

			return undefined;
		});

		await new Migration().down(pending.runner);
		expect(sqls(pending.query).some((sql) => sql.startsWith('DROP TABLE'))).toBe(false);

		const absent = runner((sql) => (sql.includes('to_regclass') ? [{ present: false }] : undefined));

		await new Migration().down(absent.runner);
		expect(sqls(absent.query)).toHaveLength(1);
	});
});

describe('migración 1791500000000 (limpieza de promedios mensuales manuales y recálculo con la regla corregida, 04-10)', () => {
	const Migration = LimpiaPromediosMensualesManuales1791500000000;
	const squash = (sql: string) => sql.replace(/\s+/g, ' ');

	it('borra solo las filas a mano: una tasa, hasta dic-2027 y sin tasas diarias de una fuente diaria detrás', () => {
		const sql = squash(Migration.MANUAL_ROWS_SQL);

		expect(sql).toContain('ma.data_points = 1');
		expect(sql).toContain(`make_date(ma.year, ma.month, 1) <= '2027-12-01'`);
		expect(sql).toContain(`AND NOT EXISTS ( SELECT 1 FROM exchange_rates er`);
		expect(sql).toContain(`er.source_type IN ('PERU_API', 'BANCOCENTRAL', 'BANCOCENTRALCHILE')`);
	});

	it('borra las inversas sin tasas propias: par inverso con tasas diarias de una fuente diaria y sin exchange_rates del par en el mes', () => {
		const sql = squash(Migration.INVERSE_ROWS_SQL);

		expect(sql).toContain('ma.data_points > 1');
		expect(sql).toContain(
			"NOT EXISTS ( SELECT 1 FROM exchange_rates er WHERE er.from_currency = ma.from_currency AND er.to_currency = ma.to_currency AND er.rate_date >= make_date(ma.year, ma.month, 1) AND er.rate_date < (make_date(ma.year, ma.month, 1) + interval '1 month') )"
		);
		expect(sql).toContain('WHERE er.from_currency = ma.to_currency AND er.to_currency = ma.from_currency');
		expect(sql).toContain(`er.source_type IN ('PERU_API', 'BANCOCENTRAL', 'BANCOCENTRALCHILE')`);
		// El recálculo arma cada par-mes solo desde las tasas de ese mismo par: no puede recrear una inversa sin tasas propias.
		expect(squash(Migration.RECALC_SQL)).toContain(
			'SELECT DISTINCT ON (er.from_currency, er.to_currency, er.rate_date) er.from_currency, er.to_currency'
		);
	});

	it('recalcula ene-2025 → sep-2026 (nunca el mes en curso) con la regla de monthly-average.ts: fuentes diarias, una por día, días hábiles', () => {
		const sql = squash(Migration.RECALC_SQL);

		expect(sql).toContain(
			`er.rate_date >= '2025-01-01'::date AND er.rate_date < LEAST('2026-10-01'::date, date_trunc('month', now() AT TIME ZONE 'America/Santiago')::date)`
		);
		expect(sql).toContain('SELECT DISTINCT ON (er.from_currency, er.to_currency, er.rate_date)');
		expect(sql).toContain(`er.source_type IN ('PERU_API', 'BANCOCENTRAL', 'BANCOCENTRALCHILE')`);
		expect(sql).toContain('EXTRACT(ISODOW FROM er.rate_date) < 6');
		expect(sql).toContain('er.created_at DESC');
		// Completo como `isMonthComplete` del cierre: días hábiles − 3 y la última tasa a ≤ 3 días del último hábil.
		expect(sql).toContain('m.data_points >= GREATEST(1, w.weekdays - 3) AND m.last_date >= w.last_weekday - 3');
	});

	it('up: respaldo fuera de public, borra con respaldo y después recalcula (solo filas existentes o meses completos) con calculated_at = now()', async () => {
		const { runner: db, query } = runner(() => undefined);

		await new Migration().up(db);
		const statements = sqls(query);
		const table = statements.findIndex((sql) => sql.includes(`CREATE TABLE IF NOT EXISTS ${Migration.BACKUP_TABLE}`));
		const remove = statements.findIndex((sql) => sql.includes('DELETE FROM exchange_rates_monthly_avg ma'));
		const recalc = statements.findIndex((sql) => sql.includes('INSERT INTO exchange_rates_monthly_avg'));

		expect(Migration.BACKUP_TABLE).toBe(`${BACKUP_SCHEMA}.exchange_rates_monthly_avg_1791500000000`);
		expect(table).toBeGreaterThan(0);
		expect(remove).toBeGreaterThan(table);
		expect(recalc).toBeGreaterThan(remove);
		expect(statements[remove]).toContain(`'deleted'`);
		const inverse = statements.findIndex((sql) => sql.includes(`'deleted_inverse'`));

		expect(inverse).toBeGreaterThan(remove);
		expect(recalc).toBeGreaterThan(inverse);
		expect(squash(statements[recalc])).toContain('WHERE ma.id IS NOT NULL OR c.complete');
		expect(squash(statements[recalc])).toContain(
			'ON CONFLICT (from_currency, to_currency, year, month) DO UPDATE SET avg_rate = EXCLUDED.avg_rate'
		);
		expect(statements[recalc]).toContain(`CASE WHEN old_id IS NULL THEN 'inserted' ELSE 'updated' END`);
	});

	it('down: deshace inserted, updated y deleted solo si siguen con los valores de la migración; borra el respaldo si no queda nada', async () => {
		const done = runner((sql) => {
			if (sql.includes('to_regclass')) return [{ present: true }];
			if (sql.includes('count(*)::int')) return [{ n: 0 }];

			return undefined;
		});

		await new Migration().down(done.runner);
		const statements = sqls(done.query);

		expect(
			statements.some(
				(sql) => sql.includes(`b.action = 'inserted'`) && sql.includes('ma.calculated_at IS NOT DISTINCT FROM b.new_calculated_at')
			)
		).toBe(true);
		expect(statements.some((sql) => sql.includes(`b.action = 'updated'`) && sql.includes('avg_rate = b.old_avg_rate'))).toBe(true);
		expect(
			statements.some(
				(sql) =>
					sql.includes(`b.action IN ('deleted', 'deleted_inverse')`) &&
					sql.includes('ON CONFLICT (from_currency, to_currency, year, month) DO NOTHING')
			)
		).toBe(true);
		expect(statements).toContain(`DROP TABLE ${Migration.BACKUP_TABLE}`);

		const absent = runner((sql) => (sql.includes('to_regclass') ? [{ present: false }] : undefined));

		await new Migration().down(absent.runner);
		expect(sqls(absent.query)).toHaveLength(1);
	});
});
