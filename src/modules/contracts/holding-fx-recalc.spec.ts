import { INVOICE_SYSTEM_SOURCE_CURRENCY_SQL } from './api-written-fields';
import { recalculateHoldingFx } from './holding-fx-recalc';

import type { QueryRunner } from 'typeorm';

/** Tasa proyectada (decisión de Domi 04-10): guardar una tasa fija del holding recalcula devengo y facturas desde su período. */

type Row = Record<string, unknown>;
const squash = (sql: string) => sql.replace(/\s+/g, ' ');

function runner(settings: Row | null, contracts: Row[] = [], invoices: Row[] = []) {
	const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql: string) => {
		const text = squash(sql);

		if (text.includes('FROM holding_settings WHERE holding_id = $1')) return settings ? [settings] : [];
		if (text.includes('FROM contracts c WHERE c.holding_id = $1')) return contracts;
		if (text.includes('SELECT i.id, i.document_type, i.related_invoice_id')) return invoices;

		return [];
	});

	return { db: { query } as unknown as QueryRunner, query, sqls: () => query.mock.calls.map(([sql]) => squash(sql as string)) };
}

const FIXED = { system_currency: 'USD', fx_system_policy: 'fixed_period' };

describe('recalculateHoldingFx', () => {
	it('política monthly_avg, par sin la moneda del sistema o par vacío → no recalcula nada', async () => {
		for (const [settings, pair] of [
			[{ system_currency: 'USD', fx_system_policy: 'monthly_avg' }, ['CLF', 'USD']],
			[FIXED, ['CLF', 'CLP']],
			[FIXED, ['USD', 'usd']],
		] as const) {
			const { db, query } = runner(settings);

			expect(await recalculateHoldingFx(db, 'h-1', [...pair], '2027-01-01')).toEqual({ from_month: null, contracts: 0, invoices: 0 });
			expect(query).toHaveBeenCalledTimes(1);
		}
	});

	it('devengo: apply_fx (sin rebuild) de los contratos en la otra moneda, desde el mes del período y nunca antes del cierre', async () => {
		const { db, query, sqls } = runner(FIXED, [
			{ id: 'c-1', from_month: '2027-01-01' },
			{ id: 'c-2', from_month: '2027-04-01' },
		]);
		const result = await recalculateHoldingFx(db, 'h-1', ['clf ', 'USD'], '2027-01-15');
		const select = query.mock.calls.find(([sql]) => squash(sql as string).includes('FROM contracts c WHERE c.holding_id = $1'))!;

		expect(select[1]).toEqual(['h-1', ['CLF'], '2027-01-01']);
		expect(squash(select[0] as string)).toContain(
			`GREATEST($3::date, COALESCE((date_trunc('month', public.get_cutoff_date(c.holding_id, c.company_id)) + interval '1 month')::date, $3::date))`
		);
		const applies = query.mock.calls.filter(([sql]) => (sql as string).includes('revenue_schedule_apply_fx_for_contract'));

		expect(applies.map(([, params]) => params)).toEqual([
			['c-1', '2027-01-01'],
			['c-2', '2027-04-01'],
		]);
		expect(sqls().some((sql) => sql.includes('revenue_schedule_rebuild'))).toBe(false);
		expect(result).toEqual({ from_month: '2027-01-01', contracts: 2, invoices: 0 });
	});

	it('facturas: moneda de factura (respaldo: la del encabezado), sin canceladas, período abierto; las NC copian la tasa de su original', async () => {
		const { db, query, sqls } = runner(
			FIXED,
			[],
			[
				{ id: 'i-1', document_type: 'Factura', related_invoice_id: null },
				{ id: 'nc-1', document_type: 'NC', related_invoice_id: 'i-1' },
			]
		);
		const result = await recalculateHoldingFx(db, 'h-1', ['USD', 'CLP'], '2027-01-01');
		const select = sqls().find((sql) => sql.includes('SELECT i.id, i.document_type, i.related_invoice_id'))!;

		// Regla de moneda de factura (04-10): se recalculan las facturas que se convierten desde la moneda del par.
		expect(select).toContain(`${squash(INVOICE_SYSTEM_SOURCE_CURRENCY_SQL)} = ANY($2::text[])`);
		expect(select).toContain('THEN UPPER(TRIM(i.invoice_currency)) ELSE');
		expect(select).toContain(`i.status IS DISTINCT FROM 'Cancelada'`);
		expect(select).toContain('public.get_cutoff_date(i.holding_id, i.company_id)');
		// refreshInvoiceSystemAmounts lee solo la factura (la NC va por el espejo).
		const refresh = query.mock.calls.find(([sql]) => (sql as string).includes(`COALESCE(hs.system_currency, 'USD') AS system_currency`))!;

		expect(refresh[1]).toEqual([['i-1'], 'h-1']);
		const mirror = query.mock.calls.find(([sql]) =>
			(sql as string).includes('UPDATE invoices n SET fx_contract_to_system = o.fx_contract_to_system')
		)!;

		expect(mirror[1]).toEqual(['nc-1', 'i-1', 'h-1']);
		expect(result).toEqual({ from_month: '2027-01-01', contracts: 0, invoices: 2 });
	});
});
