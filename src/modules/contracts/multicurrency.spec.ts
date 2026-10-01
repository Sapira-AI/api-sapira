// `ContractActivationService` arrastra el scheduler de Odoo, que importa `uuid` (solo ESM desde la v13): Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException } from '@nestjs/common';

import { fieldErrorsOf } from '@/core/utils/validation-errors';

import { ContractActivationService } from './contract-activation.service';
import { type ChangePlan, planChange } from './contract-changes';
import { insertMirrorCreditNote } from './contract-changes.service';
import { context, contractRow, invoiceRow, itemRow, PRODUCT_NUEVO, request, soporteRow } from './contract-changes.test-fixtures';
import { ContractDraftsService } from './contract-drafts.service';
import { type ContractInvoiceContext, type ContractInvoiceLineRow, type ContractInvoiceRow, planFx } from './contract-invoices';
import { multicurrencyHeader, valuateLinesByPair } from './multicurrency';

import type { CreateContractDto } from './dtos/create-contract.dto';
import type { QueryRunner } from 'typeorm';

/**
 * Multimoneda en el contrato (`docs/v2-rediseno/spec-multimoneda-contrato.md`, MM2–MM3): tasas por par y propósito al crear, bloqueos de
 * activación por par, modificaciones (`multicurrency`, `item_add` con moneda, `billing_conditions` por par), tipo de cambio por factura con
 * `rates_by_pair` y NC espejo por línea.
 */
type Row = Record<string, unknown>;
const ops = (plan: ChangePlan, kind: string): any[] => plan.ops.filter((op) => op.kind === kind);
const codeOf = (fn: () => unknown): string | undefined => {
	try {
		fn();
	} catch (error) {
		return ((error as BadRequestException).getResponse() as { code?: string }).code;
	}

	return undefined;
};

// ------------------------------------------------------------------ alta: resolveFx por par y propósito

describe('alta multimoneda: resolveFx por (propósito, from, to)', () => {
	const companyContext = (multicurrencyDefault = false) =>
		({
			company: {
				id: 'co',
				legal_name: null,
				country: 'Chile',
				currency: 'CLP',
				contract_prefix: null,
				tax_rate: 19,
				fx_company_policy: 'monthly_avg',
			},
			multicurrency_default: multicurrencyDefault,
		}) as unknown as Parameters<typeof ContractDraftsService.resolveFx>[1];
	const item = (key: string, currency: string, unit: number) => ({
		key,
		product_id: 'p',
		item_type: 'Licencias',
		quantity: 1,
		unit_price: unit,
		billing_frequency: 'Mensual' as const,
		billing_method: 'Anticipado' as const,
		start_date: '2026-01-01',
		term_months: 12,
		currency,
	});
	const dto = (overrides: Partial<CreateContractDto> = {}): CreateContractDto =>
		({
			client_id: 'c',
			client_entity_id: 'e',
			company_id: 'co',
			contract_currency: 'CLP',
			invoice_currency: 'CLP',
			fx_invoice_policy: 'fixed',
			requires_multicurrency_billing: true,
			items: [item('uf', 'CLF', 2.5), item('usd', 'USD', 10), item('clp', 'CLP', 50000)],
			fx_item_rates: [
				{ from_currency: 'CLF', rate: 39000 },
				{ from_currency: 'USD', rate: 950 },
			],
			fx_invoice_rates: [
				{ from_currency: 'CLF', rate: 39000.5 },
				{ from_currency: 'USD', rate: 950.5 },
			],
			...overrides,
		}) as CreateContractDto;
	const resolve = (body: CreateContractDto, multicurrencyDefault = false) =>
		ContractDraftsService.resolveFx(
			body,
			companyContext(multicurrencyDefault),
			ContractDraftsService.resolveItems(body, new Map([['p', 'Producto']]))
		);

	it('una tasa "todo el contrato" por par (no choca entre pares) y FxRateRow con propósito item', () => {
		const fx = resolve(dto());

		expect(fx.multicurrency).toBe(true);
		expect(fx.fx_invoice_policy).toBe('fixed');
		expect(fx.item_rates.map((row) => [row.purpose, row.from_currency, row.to_currency, row.rate])).toEqual([
			['item', 'CLF', 'CLP', 39000],
			['item', 'USD', 'CLP', 950],
		]);
		expect(fx.invoice_rates.map((row) => `${row.from_currency}>${row.to_currency}`)).toEqual(['CLF>CLP', 'USD>CLP']);
		expect(fx.invoice_rates[0]).toMatchObject({ period_start: '2026-01-01', period_end: '2026-12-31' });
	});

	it('dos tasas sin fechas del mismo par → WHOLE_CONTRACT_RATE_CONFLICT en ese par', () => {
		const error = (() => {
			try {
				resolve(
					dto({
						fx_item_rates: [
							{ from_currency: 'CLF', rate: 39000 },
							{ from_currency: 'CLF', rate: 39100 },
							{ from_currency: 'USD', rate: 950 },
						],
					})
				);
			} catch (caught) {
				return caught;
			}
		})();

		expect(fieldErrorsOf(error)?.map((row) => row.field)).toEqual(['fx_item_rates.0']);
	});

	it('falta la tasa ítem → contrato de un par → 400 item_fx_rate_missing', () => {
		expect(codeOf(() => resolve(dto({ fx_item_rates: [{ from_currency: 'CLF', rate: 39000 }] })))).toBe('item_fx_rate_missing');
	});

	it('el flag viene de la cotización cuando el body no lo trae; sin flag las tasas ítem no aplican', () => {
		expect(resolve(dto({ requires_multicurrency_billing: undefined }), true).multicurrency).toBe(true);
		expect(() =>
			resolve(
				dto({ requires_multicurrency_billing: false, items: [item('clp', 'CLP', 1)], fx_invoice_policy: undefined, fx_invoice_rates: [] })
			)
		).toThrow(BadRequestException);
	});

	it('TCV en moneda de contrato con la tasa pactada de cada ítem', () => {
		const body = dto();
		const items = ContractDraftsService.resolveItems(body, new Map([['p', 'Producto']]));

		expect(ContractDraftsService.totalValue(items, 'CLP', resolve(body))).toBe(2.5 * 12 * 39000 + 10 * 12 * 950 + 50000 * 12);
	});
});

// ------------------------------------------------------------------ activación: bloqueos por par

describe('activación multimoneda: bloqueos por par', () => {
	const draft = (overrides: Row = {}): Row => ({
		id: 'a',
		contract_number: 'CTR-2026-009',
		status: 'En revisión',
		client_entity_id: 'entity-1',
		company_id: 'company-1',
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		fx_invoice_policy: 'fixed',
		billing_anchor_day: '1',
		payment_terms: { kind: 'net', days: 30 },
		document_type: 'FACTURA',
		company_found: 'company-1',
		company_country: 'Chile',
		company_currency: 'CLP',
		company_tax_rate: '19',
		entity_found: 'entity-1',
		entity_country: 'Chile',
		invoices_count: '0',
		currency_mismatch: true,
		requires_multicurrency_billing: true,
		fx_invoice_rates: [{ from_currency: 'USD', to_currency: 'CLP', rate: 950.5, period_start: '2026-01-01', period_end: '2026-12-31' }],
		fx_item_rates: [{ from_currency: 'USD', to_currency: 'CLP', rate: 950, period_start: '2026-01-01', period_end: '2026-12-31' }],
		...overrides,
	});
	const items: Row[] = [
		{
			id: 'usd',
			product_id: 'p',
			product_name: 'Licencia',
			quantity: '1',
			unit_price: '10',
			billing_frequency: 'Mensual',
			billing_method: 'Anticipado',
			start_date: '2026-10-01',
			end_date: '2026-12-31',
			term_months: 3,
			is_recurring: true,
			currency: 'USD',
		},
		{
			id: 'clp',
			product_id: 'p',
			product_name: 'Soporte',
			quantity: '1',
			unit_price: '50000',
			billing_frequency: 'Mensual',
			billing_method: 'Anticipado',
			start_date: '2026-10-01',
			end_date: '2026-12-31',
			term_months: 3,
			is_recurring: true,
			currency: 'CLP',
		},
	];
	const codes = (plan: ReturnType<typeof ContractActivationService.evaluate>) => plan.check.blockers.map((blocker) => blocker.code);

	it('fija con tasas de cada par: se activa (sin currency_mismatch con el flag) y cada factura lleva el par por línea', () => {
		const plan = ContractActivationService.evaluate('a', draft(), items);

		expect(codes(plan)).toEqual([]);
		expect(plan.engine!.invoices[0].lines.map((line) => [line.currency, line.fx])).toEqual([
			['USD', 950.5],
			['CLP', 1],
		]);
		expect(plan.engine!.totals.mrr).toBe(10 * 950 + 50000);
	});

	it('sin el flag, un ítem en otra moneda sigue bloqueando (currency_mismatch)', () => {
		expect(codes(ContractActivationService.evaluate('a', draft({ requires_multicurrency_billing: false }), items))).toContain(
			'currency_mismatch'
		);
	});

	it('falta la tasa de facturación o la tasa ítem → bloqueos por par con el par en el mensaje', () => {
		const plan = ContractActivationService.evaluate('a', draft({ fx_invoice_rates: [], fx_item_rates: [] }), items);

		expect(codes(plan)).toEqual(['fixed_fx_without_rate', 'item_fx_rate_missing']);
		expect(plan.check.blockers.map((blocker) => blocker.message).join(' | ')).toContain('USD → CLP');
	});

	it('spot con pares que convierten se activa sin bloqueo: el envío valoriza cada par al emitir (MM4)', () => {
		expect(codes(ContractActivationService.evaluate('a', draft({ fx_invoice_policy: 'spot' }), items))).toEqual([]);
	});
});

// ------------------------------------------------------------------ modificaciones

describe('modificaciones multimoneda', () => {
	const multiContract = (overrides = {}) =>
		contractRow({
			requires_multicurrency_billing: true,
			fx_invoice_policy: 'fixed',
			fx_invoice_rates: [{ from_currency: 'USD', to_currency: 'CLP', rate: 950.5, period_start: '2026-01-01', period_end: '2026-12-31' }],
			fx_item_rates: [{ from_currency: 'USD', to_currency: 'CLP', rate: 950, period_start: '2026-01-01', period_end: '2026-12-31' }],
			...overrides,
		});

	it('multicurrency { enabled: true }: enciende el flag (set_multicurrency), evento MULTICURRENCY_ENABLED, sin ítems ni RSM', () => {
		const plan = planChange(context(), request({ type: 'multicurrency', enabled: true }));

		expect(plan.preview.can_apply).toBe(true);
		expect(ops(plan, 'set_multicurrency')).toEqual([{ kind: 'set_multicurrency', enabled: true }]);
		expect(plan.ops.map((op) => op.kind)).toEqual(['set_multicurrency']);
		expect(plan.event.type).toBe('MULTICURRENCY_ENABLED');
		expect(plan.event.rsm_from_month).toBeNull();
	});

	it('multicurrency { enabled: false } con ítems en otra moneda → blocker foreign_currency_items_present; sin ellos se apaga', () => {
		const blocked = planChange(
			context({ contract: multiContract(), items: [itemRow(), soporteRow({ currency: 'USD' })] }),
			request({ type: 'multicurrency', enabled: false })
		);

		expect(blocked.preview.blockers.map((blocker) => blocker.code)).toEqual(['foreign_currency_items_present']);
		const free = planChange(context({ contract: multiContract() }), request({ type: 'multicurrency', enabled: false }));

		expect(free.preview.can_apply).toBe(true);
		expect(free.event.type).toBe('MULTICURRENCY_DISABLED');
	});

	it('item_add en otra moneda sin multimoneda → blocker multicurrency_not_enabled con el siguiente paso', () => {
		const plan = planChange(
			context(),
			request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 10, currency: 'USD' }] })
		);
		const blocker = plan.preview.blockers.find((row) => row.code === 'multicurrency_not_enabled');

		expect(blocker?.next_step).toBe('Activa multimoneda o usa la moneda del contrato');
	});

	it('item_add USD con enable_multicurrency + tasas: flag antes del ítem, tasas por propósito, líneas por par y ΔMRR en moneda de contrato', () => {
		const plan = planChange(
			context({ contract: contractRow({ fx_invoice_policy: 'fixed' }) }),
			request({
				type: 'item_add',
				enable_multicurrency: true,
				fx_item_rates: [{ from_currency: 'USD', rate: 950 }],
				fx_invoice_rates: [{ from_currency: 'USD', rate: 950.5 }],
				items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 10, currency: 'USD' }],
			})
		);

		expect(plan.preview.blockers).toEqual([]);
		expect(plan.ops[0]).toEqual({ kind: 'set_multicurrency', enabled: true });
		expect(ops(plan, 'insert_item')[0].item.currency).toBe('USD');
		expect(ops(plan, 'insert_fx_rates')[0].rates.map((rate: Row) => [rate.purpose, rate.from_currency, rate.to_currency])).toEqual([
			['item', 'USD', 'CLP'],
			['invoice', 'USD', 'CLP'],
		]);
		const created = ops(plan, 'create_invoices')[0];
		const lines = created.invoices.flatMap((invoice: { lines: Row[] }) => invoice.lines);

		expect(lines.every((line: Row) => line.currency === 'USD' && line.fx === 950.5)).toBe(true);
		expect(plan.event.amount_delta).toBe(9500);
		expect(plan.preview.contract.after.mrr - plan.preview.contract.before.mrr).toBe(9500);
		expect(plan.event.metadata).toMatchObject({ currencies: ['USD'], multicurrency_enabled: true });
	});

	it('item_add en otra moneda sin tasa ítem → blocker item_fx_rate_missing', () => {
		const plan = planChange(
			context({ contract: multiContract({ fx_item_rates: [] }) }),
			request({ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 10, currency: 'USD' }] })
		);

		expect(plan.preview.blockers.map((row) => row.code)).toContain('item_fx_rate_missing');
	});

	it('item_add desde cotización: el ítem nace en la moneda de la cotización (cierra U10)', () => {
		const plan = planChange(
			context({ contract: multiContract(), quote: { id: 'q-1', quote_type: 'Upsell', already_applied: false, currency: 'USD' } }),
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_NUEVO, quantity: 1, unit_price: 10 }] },
				{ origin: { type: 'quote', quote_id: 'q-1' } }
			)
		);

		expect(ops(plan, 'insert_item')[0].item.currency).toBe('USD');
		expect(plan.preview.blockers).toEqual([]);
	});

	it('billing_conditions a fijo en un contrato multimoneda: 400 con el par sin tasa; con tasa por par, cada línea con su par', () => {
		const pending = invoiceRow('12');

		pending.lines[1] = { ...pending.lines[1], currency: 'USD', subtotal: 10, tax_amount: 1.9, unit_price: 10 };
		const ctx = context({
			contract: multiContract({ fx_invoice_policy: 'spot', fx_invoice_rates: [] }),
			items: [itemRow(), soporteRow({ currency: 'USD' })],
			invoices: [pending],
		});

		expect(
			codeOf(() => planChange(ctx, request({ type: 'billing_conditions', fx_invoice_policy: 'fixed' }, { effective_date: '2026-11-15' })))
		).toBe('fixed_fx_without_rate');
		const plan = planChange(
			ctx,
			request({ type: 'billing_conditions', fx_invoice_policy: 'fixed', fx_invoice_rates: [{ from_currency: 'USD', rate: 950.5 }] })
		);
		const [target] = ops(plan, 'update_invoices_fx')[0].targets;

		expect(target.fx).toBe(950.5);
		expect(target.lines).toEqual([
			{ line_id: 'line-12-lic', fx: 1, amounts: { unit_price: 100, subtotal: 1000, tax: 190, total: 1190 } },
			{ line_id: 'line-12-sop', fx: 950.5, amounts: { unit_price: 9505, subtotal: 9505, tax: 1805.95, total: 11310.95 } },
		]);
	});
});

// ------------------------------------------------------------------ tipo de cambio por factura (360) por par

describe('tipo de cambio por factura multimoneda (rates_by_pair, net_exact_multi_pair)', () => {
	const invoice = (overrides: Partial<ContractInvoiceRow> = {}): ContractInvoiceRow =>
		({
			id: 'inv-1',
			invoice_number: null,
			status: 'Por Emitir',
			document_type: 'FACTURA',
			invoice_type: 'Automatica',
			is_active: true,
			is_legacy: false,
			issue_date: '2026-12-01',
			contract_currency: 'CLP',
			invoice_currency: 'CLP',
			amount_contract_currency: 106000,
			amount_invoice_currency: null,
			vat: null,
			total_invoice_currency: null,
			fx_contract_to_invoice: null,
			tax_rate: 19,
			fx_rate_source: null,
			odoo_invoice_id: null,
			sent_to_odoo_at: null,
			consolidated_into_invoice_id: null,
			period_start: '2026-12-01',
			lines_count: 3,
			...overrides,
		}) as ContractInvoiceRow;
	const line = (id: string, currency: string, subtotal: number): ContractInvoiceLineRow => ({
		id,
		quantity: 1,
		unit_price_contract_currency: subtotal,
		subtotal_contract_currency: subtotal,
		tax_amount_contract_currency: Math.round(subtotal * 19) / 100,
		total_contract_currency: subtotal,
		unit_price_invoice_currency: null,
		subtotal_invoice_currency: null,
		tax_amount_invoice_currency: null,
		total_invoice_currency: null,
		created_at: null,
		currency,
	});
	const lines = [line('clp', 'CLP', 50000), line('usd', 'USD', 10.01), line('uf', 'CLF', 1.4)];
	const ctx = { today: '2026-11-01', cutoff_date: null } as unknown as ContractInvoiceContext;

	it('fixed con rates_by_pair: cada línea con su par, encabezado = Σ líneas y FX del encabezado NULL (dos pares)', () => {
		const plan = planFx(invoice(), lines, ctx, { policy: 'fixed', rates_by_pair: { 'USD>CLP': 950.555, 'CLF>CLP': 39000.5 } });

		expect(plan.blockers).toEqual([]);
		expect(plan.lines.map((row) => [row.id, row.fx, row.after.subtotal_invoice_currency])).toEqual([
			['clp', 1, 50000],
			['usd', 950.555, 9515.06],
			['uf', 39000.5, 54600.7],
		]);
		expect(plan.write?.fx).toBeNull();
		expect(plan.write?.header.amount_invoice_currency).toBe(114115.76);
		// La moneda de contrato no cambia con el tipo de cambio de facturación (métricas a tasa pactada).
		expect(plan.write?.header.amount_contract_currency).toBe(106000);
	});

	it('falta un par → fixed_fx_without_rate con el par', () => {
		const plan = planFx(invoice(), lines, ctx, { policy: 'fixed', rates_by_pair: { 'USD>CLP': 950 } });

		expect(plan.blockers.map((row) => row.message)).toEqual([expect.stringContaining('CLF → CLP')]);
	});

	it('net_exact con dos pares → 400 net_exact_multi_pair; con un par reparte el neto menos las líneas CLP', () => {
		expect(codeOf(() => planFx(invoice(), lines, ctx, { policy: 'net_exact', target_net_amount: 120000 }))).toBe('net_exact_multi_pair');
		const plan = planFx(invoice(), lines.slice(0, 2), ctx, { policy: 'net_exact', target_net_amount: 59600 });

		expect(plan.write?.header.amount_invoice_currency).toBe(59600);
		expect(plan.lines.find((row) => row.id === 'usd')?.after.subtotal_invoice_currency).toBe(9600);
	});
});

// ------------------------------------------------------------------ NC espejo por línea

describe('NC espejo multimoneda (insertMirrorCreditNote copia el par de cada línea)', () => {
	it('cada línea de la NC con la moneda, la tasa, el origen y la fecha de su línea original; encabezado en moneda de contrato con la tasa ítem', async () => {
		const calls: Array<[string, unknown[]]> = [];
		const runner = {
			query: jest.fn(async (sql: string, params: unknown[] = []) => {
				calls.push([sql, params]);
				if (sql.includes('FROM invoices WHERE id = $1 AND holding_id = $2'))
					return [{ contract_id: 'c-1', contract_currency: 'CLP', invoice_currency: 'CLP', fx_contract_to_invoice: null, tax_rate: 19 }];
				if (sql.includes('FROM invoice_items WHERE invoice_id = $1 AND holding_id = $2'))
					return [
						{
							id: 'l-usd',
							contract_currency: 'USD',
							fx_contract_to_invoice: '950.5',
							fx_rate_source: 'contract',
							fx_rate_date: '2026-10-01',
						},
						{
							id: 'l-clp',
							contract_currency: 'CLP',
							fx_contract_to_invoice: '1',
							fx_rate_source: 'contract',
							fx_rate_date: '2026-10-01',
						},
					];
				if (sql.includes("purpose = 'item'"))
					return [{ from_currency: 'USD', to_currency: 'CLP', rate: 950, period_start: '2026-01-01', period_end: '2026-12-31' }];
				if (sql.includes('INSERT INTO invoices')) return [{ id: 'nc-1' }];
				if (sql.includes('INSERT INTO invoice_items')) return [{ id: `ncl-${calls.length}` }];

				return [];
			}),
		} as unknown as QueryRunner;
		const base = invoiceRow('10').lines[0];
		const lines = [
			{
				line: { ...base, id: 'l-usd', subtotal: 10, subtotal_invoice: 9505, tax_amount: 1.9, tax_amount_invoice: 1805.95 },
				ratio: 1,
				period_start: '2026-10-01',
			},
			{
				line: { ...base, id: 'l-clp', subtotal: 1000, subtotal_invoice: 1000, tax_amount: 190, tax_amount_invoice: 190 },
				ratio: 1,
				period_start: '2026-10-01',
			},
		];

		await insertMirrorCreditNote(runner, { id: 'inv-10', tax_rate: 19 }, lines, 'NC', 'h-1', '2026-11-15', { exact: true });
		const header = calls.find(([sql]) => sql.includes('INSERT INTO invoices'))!;
		const ncLines = calls.filter(([sql]) => sql.includes('INSERT INTO invoice_items'));

		// Encabezado en moneda de contrato: 10 USD × 950 + 1.000 CLP.
		expect(header[1][10]).toBe(-10500);
		expect(ncLines.map(([, params]) => [params[16], params[18], params[19], params[25]])).toEqual([
			['USD', 950.5, 'contract', '2026-10-01'],
			['CLP', 1, 'contract', '2026-10-01'],
		]);
	});
});

// ------------------------------------------------------------------ helpers puros

describe('helpers multimoneda', () => {
	it('valuateLinesByPair: residuo por par a la línea mayor y FX del documento solo con un par', () => {
		const valuation = valuateLinesByPair(
			[
				{ id: 'a', currency: 'USD', unit_price: 10.01, subtotal: 10.01, tax_amount: 1.9, period_start: '2026-01-01' },
				{ id: 'b', currency: 'USD', unit_price: 20.03, subtotal: 20.03, tax_amount: 3.81, period_start: '2026-01-01' },
			],
			'CLP',
			() => 950.555,
			19
		);

		expect(valuation.lines.map((row) => row.subtotal)).toEqual([9515.06, 19039.61]);
		expect(valuation.fx).toBe(950.555);
		expect(valuation.pairs).toEqual(['USD>CLP']);
	});

	it('multicurrencyHeader: spot → NULL en moneda de factura y IVA en moneda de contrato con la tasa ítem', () => {
		const header = multicurrencyHeader(
			[
				{ currency: 'USD', subtotal: 10, tax: 1.9, subtotal_invoice: null, tax_invoice: null, fx: null, period_start: '2026-10-01' },
				{ currency: 'CLP', subtotal: 1000, tax: 190, subtotal_invoice: 1000, tax_invoice: 190, fx: 1, period_start: '2026-10-01' },
			],
			{
				contract_currency: 'CLP',
				invoice_currency: 'CLP',
				item_rates: [{ from_currency: 'USD', to_currency: 'CLP', rate: 950, period_start: '2026-01-01', period_end: '2026-12-31' }],
				fallback_date: '2026-10-01',
			}
		);

		expect(header).toEqual({ amount_contract_currency: 10500, vat: 1995, amount_invoice_currency: null, total_invoice_currency: null, fx: null });
	});
});
