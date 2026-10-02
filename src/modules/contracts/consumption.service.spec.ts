// `InvoiceSchedulerService` (envío al ERP desde el Contrato 360) importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, ConflictException, HttpException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { fieldErrorsOf, flattenValidationErrors } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';

import { lineDescription } from './billing-engine';
import { todayFor } from './business-date';
import { ConsumptionController } from './consumption.controller';
import { consumptionPeriodClosed, ConsumptionService, fitConsumptionGlosa } from './consumption.service';
import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractChangesService } from './contract-changes.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ConsumptionBulkDto, QueryConsumptionPendingDto, UpsertConsumptionDto } from './dtos/consumption.dto';
import { DEFAULT_TEMPLATE } from './invoice-description';
import { mcInvoiceRow, mcStoredLine, multicurrencyRoute, revaluedHeaders, revaluedLines } from './multicurrency.test-fixtures';
import { asciiGlosa } from './pricing-engine';

type Row = Record<string, unknown>;
type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

const CONTRACT = 'c0000000-0000-4000-8000-000000000001';
const ITEM = '77777777-7777-4777-8777-777777777777';
const OTHER_ITEM = '77777777-7777-4777-8777-777777777778';
const HOLDING = 'h-1';

/** Ítem medido: tramos del mockup, 100 gratis, mínimo 50, tope 80, descuento 10 % ya guardado en la línea. */
const meteredItemRow: Row = {
	id: ITEM,
	contract_id: CONTRACT,
	product_name: 'Rutas optimizadas',
	account: null,
	quantity: '1000',
	unit_of_measure: 'ruta',
	discount_type: 'Porcentaje',
	discount_value: '10',
	price_id: 'price-1',
	price_name: 'Tramos LatAm',
	price_version: 1,
	price_status: 'active',
	price_model: 'graduated',
	price_quantity_type: 'metered',
	price_billable_metric_id: 'm-1',
	price_tiers: [
		{ from: 1, to: 500, per_unit_amount: 0.08, flat_amount: 10 },
		{ from: 501, to: 2000, per_unit_amount: 0.06, flat_amount: 0 },
		{ from: 2001, to: null, per_unit_amount: 0.045, flat_amount: 0 },
	],
	price_free_units: '100',
	price_minimum_amount: '50',
	price_cap_amount: '80',
	metric_id: 'm-1',
	metric_code: 'rutas',
	metric_name: 'Rutas completadas',
	metric_unit: 'ruta',
	metric_aggregation: 'sum',
};

/** Ítem estándar (sin modelo de precio): Soporte, 1 UND × 100 al mes, sin descuento. */
const standardItemRow: Row = {
	id: ITEM,
	contract_id: CONTRACT,
	product_name: 'Soporte',
	account: null,
	quantity: '1',
	unit_price: '100',
	unit_of_measure: 'UND',
	discount_type: null,
	discount_value: null,
	price_id: null,
	price_model: null,
	price_quantity_type: null,
	metric_id: null,
};
/** Sobrescrituras de la línea de octubre para el ítem estándar: 1 × 100 = 100 neto. */
const standardLine: Row = {
	quantity: '1',
	unit_price_contract_currency: '100',
	subtotal_contract_currency: '100',
	discount_pct: '0',
	description: 'Soporte - Periodo 01/10/2026 a 31/10/2026',
	product_id: 'prod-2',
	unit_of_measure: 'UND',
};

/** Línea Por Emitir de octubre (pendiente, cantidad base 1.000 → 64,80) en una factura CLP→CLP (fx 1, IVA 19). */
const pendingLine = (overrides: Row = {}): Row => ({
	line_id: 'line-oct',
	invoice_id: 'inv-oct',
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	discount_pct: '10',
	quantity: '1000',
	subtotal_contract_currency: '64.80',
	invoice_number: null,
	status: 'Por Emitir',
	is_active: true,
	is_legacy: false,
	invoice_type: 'Automatica',
	document_type: 'FACTURA',
	issue_date: '2026-11-01',
	tax_rate: '19',
	fx_contract_to_invoice: '1',
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	...overrides,
});

const build = (handler: Handler = () => undefined) => {
	const route = async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('FROM contract_items ci') && sql.includes('WHERE ci.id = $1::uuid')) return params[0] === ITEM ? [meteredItemRow] : [];
		if (sql.includes('FROM invoice_items ii') && sql.includes('ii.billing_period_start = $3::date'))
			return params[2] === '2026-10-01' ? [pendingLine()] : [];
		if (sql.includes('SELECT DISTINCT ii.billing_period_start'))
			return [{ billing_period_start: '2026-10-01' }, { billing_period_start: '2026-11-01' }];
		if (sql.includes('FROM consumption_entries e WHERE e.contract_item_id')) return [];
		if (sql.includes('e.idempotency_key = $2')) return [];
		if (sql.includes('INSERT INTO consumption_entries')) return [{ id: 'entry-1' }];
		if (sql.includes('UPDATE consumption_entries')) return [{ id: 'entry-1' }];
		if (sql.includes('SELECT COALESCE(SUM(subtotal_contract_currency)')) return [{ subtotal: '178.30', tax: '33.88' }];

		return [];
	};
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query: jest.fn(route),
	};
	const dataSource = { query: jest.fn(route), createQueryRunner: jest.fn(() => runner) } as unknown as DataSource;
	const contracts = { resolveContract: jest.fn().mockResolvedValue({ id: CONTRACT, status: 'Activo' }) } as unknown as ContractsService;

	return { service: new ConsumptionService(dataSource, contracts), runner, dataSource, contracts };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const rejection = async <T extends HttpException>(promise: Promise<unknown>, type: new (...args: never[]) => T) => {
	const error = await promise.catch((caught: unknown) => caught);

	expect(error).toBeInstanceOf(type);

	return error as T;
};

describe('ConsumptionService.upsert (PUT /contracts/:id/items/:itemId/consumption/:periodStart)', () => {
	it('registra el consumo y recalcula la Por Emitir del período en una transacción: entry + revisión, línea, encabezado, RSM y evento', async () => {
		const { service, runner } = build();
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1');

		expect(runner.startTransaction).toHaveBeenCalled();
		expect(runner.commitTransaction).toHaveBeenCalled();
		expect(runner.rollbackTransaction).not.toHaveBeenCalled();
		expect(calls(runner.query, `set_config('sapira.writer', 'api', true)`)).toHaveLength(1);
		// Lecturas con lock dentro de la transacción.
		expect(calls(runner.query, 'FOR UPDATE OF ii, i')).toHaveLength(1);
		expect(calls(runner.query, 'FROM consumption_entries e WHERE e.contract_item_id')[0][0]).toContain('FOR UPDATE');

		const [entryInsert] = calls(runner.query, 'INSERT INTO consumption_entries');

		expect(entryInsert[1]).toEqual([
			HOLDING,
			CONTRACT,
			ITEM,
			'2026-10-01',
			'2026-10-31',
			1250,
			null,
			true,
			null,
			false,
			'manual',
			null,
			null,
			'user-1',
			'inv-oct',
		]);
		const [revision] = calls(runner.query, 'INSERT INTO consumption_entry_revisions');

		expect(revision[1]).toEqual([HOLDING, 'entry-1', 1, 1250, null, true, 'manual', null, 'user-1']);

		// Línea: 1.250 rutas → 78,30 (mockup), IVA 19 % = 14,88, total 93,18; misma moneda → mismos montos en factura.
		const [lineUpdate] = calls(runner.query, 'UPDATE invoice_items SET quantity');

		expect(lineUpdate[1].slice(0, 11)).toEqual(['line-oct', HOLDING, 1250, 0.06264, 0.06264, 78.3, 78.3, 14.88, 14.88, 93.18, 93.18]);
		expect(JSON.parse(lineUpdate[1][11] as string).map((subline: Row) => [subline.kind, subline.amount])).toEqual([
			['free', 0],
			['tier', 42],
			['tier', 45],
			['discount', -8.7],
		]);
		// §3.8 `single`: la glosa se reescribe con el detalle por tramo (la base se conserva).
		expect(lineUpdate[1].slice(12)).toEqual([
			'consumption',
			ITEM,
			'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Tramos: gratis 100; 101-500 x 0,08 + fijo 10,00; 501-1.250 x 0,06; descuento -8,70',
		]);
		expect(lineUpdate[0]).toContain('AND contract_item_id = $14');

		// Encabezado = Σ líneas releídas (otras líneas intactas): 178,30 neto, IVA 33,88, total 212,18.
		const [headerUpdate] = calls(runner.query, 'UPDATE invoices SET amount_contract_currency');

		expect(headerUpdate[1]).toEqual(['inv-oct', HOLDING, 178.3, 33.88, 178.3, 212.18, 19]);
		expect(headerUpdate[0]).toContain(`status = 'Por Emitir'`);
		// Devengo del mes del período y evento con cantidad anterior/nueva.
		expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT, '2026-10-01']);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(event[1][2]).toBe('CONSUMPTION_RECORDED');
		expect(event[1][4]).toBe(
			'Se registró el consumo de "Rutas optimizadas" del período 2026-10-01 a 2026-10-31: 1250 ruta (factura inv-oct recalculada)'
		);
		expect(JSON.parse(event[1][8] as string)).toMatchObject({
			source: 'api_v2',
			entry_source: 'manual',
			revision: 1,
			previous_quantity: null,
			quantity: 1250,
			line_subtotal: 78.3,
		});

		expect(result).toMatchObject({
			entry: {
				id: 'entry-1',
				contract_item_id: ITEM,
				period_start: '2026-10-01',
				period_end: '2026-10-31',
				quantity: 1250,
				revision: 1,
				source: 'manual',
			},
			line: {
				id: 'line-oct',
				invoice_id: 'inv-oct',
				quantity: 1250,
				quantity_source: 'consumption',
				subtotal: 78.3,
				tax_amount: 14.88,
				total: 93.18,
			},
			invoice: { id: 'inv-oct', status: 'Por Emitir', subtotal: 178.3, tax: 33.88, total: 212.18, fx: 1 },
			lines: [{ id: 'line-oct', quantity: 1250, subtotal: 78.3, tax_amount: 14.88, total: 93.18, quantity_source: 'consumption' }],
			event: 'CONSUMPTION_RECORDED',
			mode: 'recompute',
			on_issued: 'block',
			issued_invoice: null,
			additional_amount: null,
			additional_allowed: false,
			additional_reason: null,
			credit_note: null,
			cancelled_invoice: null,
			created: {},
			idempotent: false,
			warnings: [],
		});
	});

	it('corregir: exige motivo (400), sube la revisión, guarda el rastro y deja CONSUMPTION_CORRECTED con la cantidad anterior', async () => {
		const existing = {
			id: 'entry-1',
			contract_item_id: ITEM,
			period_start: '2026-10-01',
			period_end: '2026-10-31',
			quantity: '1250',
			amount_override: null,
			apply_item_discount: true,
			account: null,
			is_estimated: false,
			source: 'manual',
			revision: 1,
			correction_reason: null,
			notes: 'nota',
			idempotency_key: null,
			created_at: new Date('2026-11-02T10:00:00.000Z'),
			updated_at: new Date('2026-11-02T10:00:00.000Z'),
		};
		const withExisting: Handler = (sql) => (sql.includes('FROM consumption_entries e WHERE e.contract_item_id') ? [existing] : undefined);
		const missingReason = build(withExisting);
		const error = await rejection(
			missingReason.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 300 }, HOLDING, 'auth-1'),
			BadRequestException
		);

		expect(fieldErrorsOf(error)).toEqual([
			{ field: 'correction_reason', message: 'Escribe el motivo de la corrección: el período ya tiene consumo registrado' },
		]);
		expect(missingReason.runner.rollbackTransaction).toHaveBeenCalled();
		expect(calls(missingReason.runner.query, 'UPDATE invoice_items')).toHaveLength(0);

		const corrected = build(withExisting);
		const result = await corrected.service.upsert(
			CONTRACT,
			ITEM,
			'2026-10-01',
			{ quantity: 300, correction_reason: 'Reporte del cliente' },
			HOLDING,
			'auth-1'
		);
		const [update] = calls(corrected.runner.query, 'UPDATE consumption_entries SET');

		expect(update[1]).toEqual([
			'entry-1',
			HOLDING,
			300,
			null,
			true,
			null,
			false,
			'manual',
			null,
			2,
			'Reporte del cliente',
			'nota',
			'user-1',
			'inv-oct',
		]);
		expect(calls(corrected.runner.query, 'INSERT INTO consumption_entry_revisions')[0][1]).toEqual([
			HOLDING,
			'entry-1',
			2,
			300,
			null,
			true,
			'manual',
			'Reporte del cliente',
			'user-1',
		]);
		// 300 rutas → 23,40 + mínimo comprometido 26,60 = 50,00.
		expect(calls(corrected.runner.query, 'UPDATE invoice_items SET quantity')[0][1][5]).toBe(50);
		expect(result.event).toBe('CONSUMPTION_CORRECTED');
		expect(result.entry.revision).toBe(2);
		expect(calls(corrected.runner.query, 'INSERT INTO contract_lifecycle_events')[0][1][4]).toContain('1250 → 300');
	});

	it('409 consumption_period_issued si la factura del período está emitida y no anulada: no se escribe nada (S7-7)', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('ii.billing_period_start = $3::date')
				? [pendingLine({ status: 'Cancelada', invoice_id: 'old' }), pendingLine({ status: 'Pagada', invoice_number: 'F-0042' })]
				: undefined
		);
		const error = await rejection(service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1'), ConflictException);

		expect(error.getResponse()).toMatchObject({
			code: 'consumption_period_issued',
			message: 'La factura F-0042 del período ya fue emitida: anula y reemite, o registra el consumo adicional',
		});
		expect(runner.rollbackTransaction).toHaveBeenCalled();
		expect(calls(runner.query, 'INSERT INTO consumption_entries')).toHaveLength(0);
		expect(calls(runner.query, 'UPDATE invoice')).toHaveLength(0);
	});

	it('409 period_out_of_item si el ítem no tiene línea que empiece ese día, con los períodos válidos; 404 ítem ajeno; 400 fecha inválida', async () => {
		const { service } = build();
		const out = await rejection(service.upsert(CONTRACT, ITEM, '2026-10-15', { quantity: 1 }, HOLDING, 'auth-1'), ConflictException);

		expect(out.getResponse()).toMatchObject({ code: 'period_out_of_item', periods: ['2026-10-01', '2026-11-01'] });
		await rejection(service.upsert(CONTRACT, OTHER_ITEM, '2026-10-01', { quantity: 1 }, HOLDING, 'auth-1'), NotFoundException);
		await rejection(service.upsert(CONTRACT, ITEM, '2026-10', { quantity: 1 }, HOLDING, 'auth-1'), BadRequestException);
	});

	it('ítem estándar con la Por Emitir: la cantidad se aplica como cantidad × unitario del período (glosa intacta, desglose tier, quantity_source consumption)', async () => {
		const { service, runner } = build((sql) => {
			if (sql.includes('WHERE ci.id = $1::uuid')) return [standardItemRow];
			if (sql.includes('ii.billing_period_start = $3::date')) return [pendingLine(standardLine)];
			if (sql.includes('SELECT COALESCE(SUM(subtotal_contract_currency)')) return [{ subtotal: '500', tax: '95' }];

			return undefined;
		});
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 5 }, HOLDING, 'auth-1');

		expect(runner.commitTransaction).toHaveBeenCalled();
		const [update] = calls(runner.query, 'UPDATE invoice_items SET quantity');

		// 5 × 100 = 500; IVA 95; total 595; una sublínea "Por unidad"; la glosa no cambia (como las cantidades variables del front viejo).
		expect(update[1].slice(0, 11)).toEqual(['line-oct', HOLDING, 5, 100, 100, 500, 500, 95, 95, 595, 595]);
		expect(JSON.parse(update[1][11] as string)).toEqual([{ kind: 'tier', quantity: 5, unit_amount: 100, amount: 500, label: 'Por unidad' }]);
		expect(update[1].slice(12)).toEqual(['consumption', ITEM, 'Soporte - Periodo 01/10/2026 a 31/10/2026']);
		expect(calls(runner.query, 'UPDATE invoices SET amount_contract_currency')[0][1]).toEqual(['inv-oct', HOLDING, 500, 95, 500, 595, 19]);
		expect(calls(runner.query, 'INSERT INTO consumption_entries')).toHaveLength(1);
		expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events')[0][1][2]).toBe('CONSUMPTION_RECORDED');
		expect(result).toMatchObject({
			mode: 'recompute',
			apply_as: 'recompute',
			on_issued: 'block',
			complements_invoice: null,
			entry: { quantity: 5, invoice_id: 'inv-oct' },
			line: { quantity: 5, effective_unit_price: 100, subtotal: 500, quantity_source: 'consumption' },
			lines: [{ id: 'line-oct', quantity: 5, unit_price: 100, subtotal: 500, tax_amount: 95, total: 595 }],
			invoice: { id: 'inv-oct', subtotal: 500, tax: 95, total: 595 },
		});
		// Sin unitario en la línea, usa el del ítem.
		const fallback = build((sql) => {
			if (sql.includes('WHERE ci.id = $1::uuid')) return [standardItemRow];
			if (sql.includes('ii.billing_period_start = $3::date')) return [pendingLine({ ...standardLine, unit_price_contract_currency: null })];

			return undefined;
		});
		const preview = await fallback.service.preview(CONTRACT, ITEM, '2026-10-01', { quantity: 2 }, HOLDING);

		expect(preview.line).toMatchObject({ quantity: 2, subtotal: 200 });
	});

	it('solo facturas anuladas en el período: guarda la entry sin recalcular (la Por Emitir de reemplazo la tomará)', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('ii.billing_period_start = $3::date') ? [pendingLine({ status: 'Anulada' })] : undefined
		);
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1');

		expect(calls(runner.query, 'INSERT INTO consumption_entries')).toHaveLength(1);
		expect(calls(runner.query, 'UPDATE invoice_items')).toHaveLength(0);
		expect(calls(runner.query, 'revenue_schedule_rebuild')).toHaveLength(0);
		expect(result.line).toBeNull();
		expect(result.invoice).toBeNull();
		expect(result.warnings[0]).toContain('solo tiene facturas anuladas');
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('idempotencia: una clave ya registrada devuelve la entry existente sin escribir', async () => {
		const { service, runner } = build((sql) => {
			if (sql.includes('e.idempotency_key = $2')) return [{ id: 'entry-1', contract_item_id: ITEM, period_start: '2026-10-01' }];
			if (sql.includes('FROM consumption_entries e WHERE e.contract_item_id'))
				return [
					{
						id: 'entry-1',
						contract_item_id: ITEM,
						period_start: '2026-10-01',
						period_end: '2026-10-31',
						quantity: '1250',
						revision: 1,
						source: 'api',
						apply_item_discount: true,
						is_estimated: false,
					},
				];

			return undefined;
		});
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 999, idempotency_key: 'sf:li-1:2026-10' }, HOLDING, 'auth-1');

		expect(result).toMatchObject({ idempotent: true, entry: { id: 'entry-1', quantity: 1250 }, line: null });
		expect(calls(runner.query, 'INSERT INTO consumption_entries')).toHaveLength(0);
		expect(calls(runner.query, 'UPDATE invoice')).toHaveLength(0);
		expect(runner.rollbackTransaction).toHaveBeenCalled();
	});

	it('monto informado por el cliente: la línea usa ese monto (menos descuento si aplica) y la cantidad queda informativa', async () => {
		const { service, runner } = build();

		await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, amount_override: 100, apply_item_discount: false }, HOLDING, 'auth-1');
		const [lineUpdate] = calls(runner.query, 'UPDATE invoice_items SET quantity');

		expect(lineUpdate[1].slice(2, 6)).toEqual([1250, 0.08, 0.08, 100]);
		expect(calls(runner.query, 'INSERT INTO consumption_entries')[0][1].slice(5, 8)).toEqual([1250, 100, false]);
	});

	it('con tipo de cambio fijo los montos en moneda de factura salen de la tasa de la factura; con spot quedan NULL', async () => {
		const fixed = build((sql) =>
			sql.includes('ii.billing_period_start = $3::date')
				? [pendingLine({ fx_contract_to_invoice: '0.0011', invoice_currency: 'USD' })]
				: undefined
		);

		await fixed.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1');
		expect(calls(fixed.runner.query, 'UPDATE invoice_items SET quantity')[0][1].slice(2, 11)).toEqual([
			1250, 0.06264, 0.000069, 78.3, 0.09, 14.88, 0.02, 93.18, 0.1,
		]);
		expect(calls(fixed.runner.query, 'UPDATE invoices SET amount_contract_currency')[0][1]).toEqual([
			'inv-oct',
			HOLDING,
			178.3,
			0.04,
			0.19613,
			0.23,
			19,
		]);

		const spot = build((sql) =>
			sql.includes('ii.billing_period_start = $3::date') ? [pendingLine({ fx_contract_to_invoice: null, invoice_currency: 'USD' })] : undefined
		);

		await spot.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1');
		expect(calls(spot.runner.query, 'UPDATE invoice_items SET quantity')[0][1].slice(2, 11)).toEqual([
			1250,
			0.06264,
			null,
			78.3,
			null,
			14.88,
			null,
			93.18,
			null,
		]);
		expect(calls(spot.runner.query, 'UPDATE invoices SET amount_contract_currency')[0][1]).toEqual([
			'inv-oct',
			HOLDING,
			178.3,
			33.88,
			null,
			null,
			19,
		]);
	});
});

describe('ConsumptionService · factura emitida (§4.4: on_issued) y per_tier (§3.8)', () => {
	/** Octubre ya emitido y pagado: F-0042 por 1.000 rutas = 64,80 neto (77,11 total). */
	const paidLine = (overrides: Row = {}) =>
		pendingLine({
			line_id: 'line-paid',
			invoice_id: 'inv-paid',
			invoice_number: 'F-0042',
			status: 'Pagada',
			description: 'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026',
			product_id: 'prod-1',
			unit_of_measure: 'ruta',
			invoice_total: '77.11',
			...overrides,
		});
	const paidHeader: Row = {
		id: 'inv-paid',
		invoice_number: 'F-0042',
		status: 'Pagada',
		issue_date: '2026-11-01',
		due_date: '2026-12-01',
		company_id: 'co-1',
		client_id: 'cl-1',
		client_entity_id: 'ce-1',
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		system_currency: 'USD',
		fx_contract_to_invoice: '1',
		tax_rate: '19',
		document_type: 'FACTURA',
		export_type: 0,
		issuer_tax_id: '76.000.000-1',
		issuer_legal_name: 'Sapira SpA',
		issuer_address: 'Santiago',
		client_tax_id: '77.000.000-2',
		payment_method: 'CREDITO',
		fiscal_regime: null,
		invoice_series: 'FAC',
		requires_references_for_billing: false,
		auto_invoice: false,
		invoice_terms_and_conditions: 'T&C',
		contract_document_type: 'FACTURA',
		fx_invoice_policy: null,
		payment_terms: { kind: 'net', days: 30 },
		company_country: 'CL',
		entity_payment_terms: null,
	};
	const paidLines: Row[] = [
		{
			id: 'line-paid',
			invoice_id: 'inv-paid',
			contract_item_id: ITEM,
			product_id: 'prod-1',
			description: 'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026',
			quantity: '1000',
			unit_of_measure: 'ruta',
			unit_price_contract_currency: '0.0648',
			unit_price_invoice_currency: '0.0648',
			discount_pct: '10',
			subtotal_contract_currency: '64.80',
			subtotal_invoice_currency: '64.80',
			tax_amount_contract_currency: '12.31',
			tax_amount_invoice_currency: '12.31',
			total_contract_currency: '77.11',
			total_invoice_currency: '77.11',
			billing_period_start: '2026-10-01',
			billing_period_end: '2026-10-31',
			quantity_source: 'pending',
			pricing_breakdown: null,
		},
		{
			id: 'line-other',
			invoice_id: 'inv-paid',
			contract_item_id: OTHER_ITEM,
			product_id: 'prod-2',
			description: 'Soporte - Periodo 01/10/2026 a 31/10/2026',
			quantity: '1',
			unit_of_measure: 'UND',
			unit_price_contract_currency: '100',
			unit_price_invoice_currency: '100',
			discount_pct: '0',
			subtotal_contract_currency: '100',
			subtotal_invoice_currency: '100',
			tax_amount_contract_currency: '19',
			tax_amount_invoice_currency: '19',
			total_contract_currency: '119',
			total_invoice_currency: '119',
			billing_period_start: '2026-10-01',
			billing_period_end: '2026-10-31',
			quantity_source: 'fixed',
			pricing_breakdown: null,
		},
	];
	let sequence = 0;
	const issuedWorld = (): Handler => (sql) => {
		if (sql.includes('ii.billing_period_start = $3::date')) return [paidLine()];
		if (sql.includes('FROM invoices i') && sql.includes('WHERE i.id = $1')) return [paidHeader];
		// Encabezado que lee la NC espejo (`insertMirrorCreditNote`).
		if (sql.includes('FROM invoices WHERE id = $1 AND holding_id = $2'))
			return [{ ...paidHeader, contract_id: CONTRACT, fx_contract_to_system: null }];
		if (sql.includes('FROM invoice_items ii WHERE ii.invoice_id = $1')) return paidLines;
		if (sql.includes('SELECT contract_id FROM invoices')) return [{ contract_id: CONTRACT }];
		if (sql.includes('INSERT INTO invoices')) return [{ id: sql.includes(`'NC'`) ? 'nc-1' : 'inv-new' }];
		if (sql.includes('INSERT INTO invoice_items')) return [{ id: `line-new-${++sequence}` }];

		return undefined;
	};

	beforeEach(() => {
		sequence = 0;
	});

	it('block (default): el 409 trae la emitida, el monto adicional y si la complementaria es posible, además de las dos opciones', async () => {
		const { service, runner } = build(issuedWorld());
		const error = await rejection(service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1'), ConflictException);

		expect(error.getResponse()).toMatchObject({
			code: 'consumption_period_issued',
			issued_invoice: { id: 'inv-paid', invoice_number: 'F-0042', status: 'Pagada', issue_date: '2026-11-01', total: 77.11, currency: 'CLP' },
			additional_amount: 13.5,
			additional_allowed: true,
			additional_reason: null,
			options: [expect.objectContaining({ on_issued: 'additional' }), expect.objectContaining({ on_issued: 'reissue' })],
		});
		expect(runner.rollbackTransaction).toHaveBeenCalled();
		expect(calls(runner.query, 'INSERT INTO')).toHaveLength(0);
		// Menos consumo que el facturado: la complementaria no es posible y el 409 lo dice.
		const lower = build(issuedWorld());
		const lowerError = await rejection(
			lower.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 300 }, HOLDING, 'auth-1'),
			ConflictException
		);

		expect(lowerError.getResponse()).toMatchObject({ additional_amount: -14.8, additional_allowed: false });
		expect((lowerError.getResponse() as Row).additional_reason).toContain('usa reemplazar (apply_as = reissue)');
		// `apply_as` y `on_issued` son intercambiables en el body; `on_issued: block` sigue siendo el 409.
		const alias = build(issuedWorld());

		await rejection(
			alias.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, on_issued: 'block' }, HOLDING, 'auth-1'),
			ConflictException
		);
	});

	it('multimoneda: la complementaria no toma la tasa del encabezado clonado; su línea se valoriza con su par y el encabezado = Σ líneas', async () => {
		const world = issuedWorld();
		const mc = multicurrencyRoute({
			contract_id: CONTRACT,
			invoices: { 'inv-new': mcInvoiceRow('inv-new', CONTRACT) },
			lines: { 'inv-new': [mcStoredLine('line-new-1', 'USD', { subtotal_contract_currency: '400', tax_amount_contract_currency: '76' })] },
		});
		const additional = build((sql, params) => {
			if (sql.includes('WHERE ci.id = $1::uuid')) return [standardItemRow];
			if (sql.includes('ii.billing_period_start = $3::date')) return [paidLine(standardLine)];
			if (sql.includes('FROM invoices i') && sql.includes('WHERE i.id = $1') && sql.includes('requires_multicurrency_billing'))
				return [{ ...paidHeader, requires_multicurrency_billing: true }];

			return mc(sql, params) ?? world(sql, params);
		});
		const result = await additional.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 5, apply_as: 'additional' }, HOLDING, 'auth-1');
		const [line] = calls(additional.runner.query, 'INSERT INTO invoice_items');

		// $19 = tasa de la línea: NULL al insertar (la pone la valorización por par).
		expect((line[1] as unknown[])[18]).toBeNull();
		expect(revaluedLines(additional.runner.query.mock.calls)).toEqual([
			expect.objectContaining({ id: 'line-new-1', currency: 'USD', fx: 950, subtotal: 380000, tax: 72200 }),
		]);
		expect(revaluedHeaders(additional.runner.query.mock.calls)).toEqual([
			expect.objectContaining({ id: 'inv-new', fx: 950, amount_invoice_currency: 380000, amount_contract_currency: 360000 }),
		]);
		expect(result.invoice).toMatchObject({ id: 'inv-new', fx: 950, subtotal: 360000, tax: 72200, total: 452200 });
	});

	it('ítem estándar con la factura del período emitida: recompute → 409 item_not_metered con la emitida y las dos salidas; additional y reissue funcionan con la misma diferencia', async () => {
		const standardIssued = (): Handler => {
			const world = issuedWorld();

			return (sql, params) => {
				if (sql.includes('WHERE ci.id = $1::uuid')) return [standardItemRow];
				if (sql.includes('ii.billing_period_start = $3::date')) return [paidLine(standardLine)];

				return world(sql, params);
			};
		};
		const blocked = build(standardIssued());
		const error = await rejection(blocked.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 5 }, HOLDING, 'auth-1'), ConflictException);

		expect(error.getResponse()).toMatchObject({
			code: 'item_not_metered',
			invoice: { id: 'inv-paid', invoice_number: 'F-0042', status: 'Pagada' },
			options: [expect.objectContaining({ apply_as: 'additional' }), expect.objectContaining({ apply_as: 'reissue' })],
		});
		expect(calls(blocked.runner.query, 'INSERT INTO')).toHaveLength(0);

		// additional: 5 × 100 = 500 − 100 ya facturados = 400 en 4 unidades adicionales; la emitida no se toca.
		const additional = build(standardIssued());
		const result = await additional.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 5, apply_as: 'additional' }, HOLDING, 'auth-1');
		const [line] = calls(additional.runner.query, 'INSERT INTO invoice_items');

		expect((line[1] as unknown[]).slice(4, 6)).toEqual(['Soporte - Periodo 01/10/2026 a 31/10/2026 - Consumo adicional sobre F-0042', 4]);
		expect((line[1] as unknown[]).slice(8, 16)).toEqual([100, 100, 400, 400, 76, 76, 476, 476]);
		expect(JSON.parse(line[1][24] as string)).toEqual([
			{ kind: 'tier', quantity: 5, unit_amount: 100, amount: 500, label: 'Por unidad' },
			{ kind: 'invoiced', quantity: 1, amount: -100, label: 'Ya facturado en F-0042', invoice_id: 'inv-paid' },
		]);
		expect(calls(additional.runner.query, 'UPDATE invoices')).toHaveLength(0);
		expect(result).toMatchObject({
			mode: 'additional',
			apply_as: 'additional',
			on_issued: 'additional',
			event: 'CONSUMPTION_ADDITIONAL_INVOICE',
			complements_invoice: { id: 'inv-paid', invoice_number: 'F-0042', status: 'Pagada' },
			issued_invoice: { id: 'inv-paid' },
			additional_amount: 400,
			invoice: { id: 'inv-new', subtotal: 400, tax: 76, total: 476 },
			entry: { invoice_id: 'inv-new', quantity: 5 },
		});

		// reissue: NC espejo + factura nueva con la línea del ítem recalculada (5 × 100) y la otra línea intacta.
		const reissue = build(standardIssued());
		const reissued = await reissue.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 5, apply_as: 'reissue' }, HOLDING, 'auth-1');

		expect(reissued).toMatchObject({
			mode: 'reissue',
			event: 'CONSUMPTION_REISSUE',
			credit_note: { id: 'nc-1' },
			cancelled_invoice: { id: 'inv-paid', invoice_number: 'F-0042' },
			invoice: { id: 'inv-new', subtotal: 600 },
			lines: [{ quantity: 5, unit_price: 100, subtotal: 500 }],
		});
	});

	it('Por Emitir + additional: la factura del período no se toca y la diferencia va a una factura nueva Por Emitir con fecha de hoy (vencimiento según condición de pago)', async () => {
		const pendingHeader: Row = {
			...paidHeader,
			id: 'inv-oct',
			invoice_number: null,
			status: 'Por Emitir',
			issue_date: '2026-11-01',
			due_date: '2026-12-01',
		};
		const pendingWorld: Handler = (sql) => {
			if (sql.includes('FROM invoices i') && sql.includes('WHERE i.id = $1')) return [pendingHeader];
			if (sql.includes('SELECT contract_id FROM invoices')) return [{ contract_id: CONTRACT }];
			if (sql.includes('INSERT INTO invoices')) return [{ id: 'inv-extra' }];
			if (sql.includes('INSERT INTO invoice_items')) return [{ id: `line-extra-${++sequence}` }];

			return undefined;
		};
		const { service, runner } = build(pendingWorld);
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, apply_as: 'additional' }, HOLDING, 'auth-1');

		expect(runner.commitTransaction).toHaveBeenCalled();
		const [header] = calls(runner.query, 'INSERT INTO invoices');
		// "Hoy" en la zona del holding (America/Santiago), igual que el servicio: en UTC ya puede ser el día siguiente después de las 21:00.
		const today = todayFor(null);

		// Clon de la Por Emitir del período con fecha de hoy y vencimiento a 30 días; montos = la diferencia (13,50).
		expect(header[0]).toContain(`'Por Emitir'`);
		expect(header[1].slice(0, 7)).toEqual([HOLDING, CONTRACT, 'co-1', 'cl-1', 'ce-1', today, expect.any(String)]);
		expect(new Date(header[1][6] as string).getTime() - new Date(today).getTime()).toBe(30 * 86_400_000);
		expect(header[1].slice(10, 15)).toEqual([13.5, 13.5, 2.57, 16.07, 1]);
		expect(header[1][28]).toBe(
			'Consumo adicional del período 2026-10-01 a 2026-10-31 sobre la factura Por Emitir inv-oct: 1250 ruta informados, 1000 ya incluidos (CLP 64.8)'
		);
		const [line] = calls(runner.query, 'INSERT INTO invoice_items');

		expect((line[1] as unknown[]).slice(4, 6)).toEqual([
			'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Consumo adicional sobre inv-oct',
			250,
		]);
		expect((line[1] as unknown[]).slice(10, 12)).toEqual([13.5, 13.5]);
		expect((line[1] as unknown[])[20]).toBe(today);
		expect(JSON.parse(line[1][24] as string).at(-1)).toEqual({
			kind: 'invoiced',
			quantity: 1000,
			amount: -64.8,
			label: 'Ya incluido en la factura Por Emitir inv-oct',
			invoice_id: 'inv-oct',
		});
		// La Por Emitir del período queda intacta: ni sus filas ni su encabezado.
		expect(calls(runner.query, 'UPDATE invoices')).toHaveLength(0);
		expect(calls(runner.query, 'UPDATE invoice_items SET quantity')).toHaveLength(0);
		expect(calls(runner.query, 'DELETE FROM invoice_items')).toHaveLength(0);
		// Entry → la nueva; devengo del mes; evento con el vínculo a la Por Emitir.
		expect(calls(runner.query, 'INSERT INTO consumption_entries')[0][1].at(-1)).toBe('inv-extra');
		expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT, '2026-10-01']);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(event[1][2]).toBe('CONSUMPTION_ADDITIONAL_INVOICE');
		expect(event[1][4]).toContain('(complementaria inv-extra por CLP 13.5 sobre inv-oct, Por Emitir)');
		expect(JSON.parse(event[1][8] as string)).toMatchObject({
			mode: 'additional',
			invoice_id: 'inv-extra',
			complements_invoice_id: 'inv-oct',
			complements_invoice_status: 'Por Emitir',
			additional_amount: 13.5,
			already_invoiced: 64.8,
		});
		expect(result).toMatchObject({
			mode: 'additional',
			apply_as: 'additional',
			on_issued: 'additional',
			event: 'CONSUMPTION_ADDITIONAL_INVOICE',
			complements_invoice: { id: 'inv-oct', invoice_number: null, status: 'Por Emitir', issue_date: '2026-11-01' },
			issued_invoice: null,
			additional_amount: 13.5,
			additional_allowed: true,
			additional_reason: null,
			created: { invoice_id: 'inv-extra' },
			invoice: { id: 'inv-extra', status: 'Por Emitir', issue_date: today, subtotal: 13.5, tax: 2.57, total: 16.07 },
			lines: [{ id: 'line-extra-1', quantity: 250, subtotal: 13.5 }],
			entry: { invoice_id: 'inv-extra', quantity: 1250 },
		});

		// Preview: lo mismo sin escribir. Sin diferencia positiva → 400 que apunta a recompute. reissue con la Por Emitir = recompute con aviso.
		const preview = build(pendingWorld);
		const previewed = await preview.service.preview(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, apply_as: 'additional' }, HOLDING);

		expect(previewed).toMatchObject({
			mode: 'additional',
			complements_invoice: { id: 'inv-oct', status: 'Por Emitir' },
			invoice: { id: '', status: 'Por Emitir', issue_date: today, subtotal: 13.5 },
			lines: [{ id: null, quantity: 250, subtotal: 13.5 }],
			created: {},
		});
		expect(preview.dataSource.createQueryRunner).not.toHaveBeenCalled();
		const lower = await rejection(
			preview.service.preview(CONTRACT, ITEM, '2026-10-01', { quantity: 300, apply_as: 'additional' }, HOLDING),
			BadRequestException
		);

		expect((lower.getResponse() as Row).message).toContain('usa recalcular (apply_as = recompute)');
		const recomputed = await preview.service.preview(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, apply_as: 'reissue' }, HOLDING);

		expect(recomputed).toMatchObject({ mode: 'recompute', apply_as: 'reissue', on_issued: 'reissue', invoice: { id: 'inv-oct' } });
		expect(recomputed.warnings).toContain('La factura del período está Por Emitir: se recalcula (reemitir solo aplica a facturas emitidas)');
	});

	it('additional: crea una factura complementaria Por Emitir del mismo período con UNA línea por la diferencia (13,50), enlaza la entry y deja CONSUMPTION_ADDITIONAL_INVOICE; la emitida no se toca', async () => {
		const { service, runner } = build(issuedWorld());
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, on_issued: 'additional' }, HOLDING, 'auth-1');

		expect(runner.commitTransaction).toHaveBeenCalled();
		const [header] = calls(runner.query, 'INSERT INTO invoices');

		// Clon de la emitida: receptor, emisor, monedas; hoy como fecha; FX 1 (misma moneda); montos = la línea; nota con el vínculo.
		expect(header[0]).toContain(`'Por Emitir'`);
		expect(header[0]).toContain(`'Automatica'`);
		expect(header[1].slice(0, 5)).toEqual([HOLDING, CONTRACT, 'co-1', 'cl-1', 'ce-1']);
		expect(header[1].slice(7, 15)).toEqual(['CLP', 'CLP', 'USD', 13.5, 13.5, 2.57, 16.07, 1]);
		expect(header[1].slice(15, 19)).toEqual(['FACTURA', 0, 19, 'FAC']);
		expect(header[1].slice(25, 28)).toEqual([false, false, 'T&C']);
		expect(header[1][28]).toBe(
			'Consumo adicional del período 2026-10-01 a 2026-10-31 sobre F-0042: 1250 ruta informados, 1000 ya facturados (CLP 64.8)'
		);
		// Vencimiento = hoy + 30 (condición de pago del contrato).
		const issueDate = header[1][5] as string;

		expect(new Date(header[1][6] as string).getTime() - new Date(issueDate).getTime()).toBe(30 * 86_400_000);

		const lineInserts = calls(runner.query, 'INSERT INTO invoice_items');

		expect(lineInserts).toHaveLength(1);
		const line = lineInserts[0][1] as unknown[];

		// 250 rutas adicionales × 0,054 = 13,50; IVA 2,57; desglose completo + ya facturado −64,80 apuntando a la emitida.
		expect(line.slice(0, 8)).toEqual([
			'inv-new',
			HOLDING,
			CONTRACT,
			'prod-1',
			'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Consumo adicional sobre F-0042',
			250,
			'ruta',
			10,
		]);
		expect(line.slice(8, 16)).toEqual([0.054, 0.054, 13.5, 13.5, 2.57, 2.57, 16.07, 16.07]);
		expect(line.slice(21, 24)).toEqual(['2026-10-01', '2026-10-31', 'consumption']);
		const breakdown = JSON.parse(line[24] as string) as Row[];

		expect(breakdown.map((subline) => [subline.kind, subline.amount])).toEqual([
			['free', 0],
			['tier', 42],
			['tier', 45],
			['discount', -8.7],
			['invoiced', -64.8],
		]);
		expect(breakdown.at(-1)).toMatchObject({ invoice_id: 'inv-paid', quantity: 1000 });
		// Costura: el ítem va en el mismo INSERT (último parámetro), sin UPDATE posterior (patrón B retirado).
		expect(calls(runner.query, 'INSERT INTO invoice_items').map(([, params]) => (params as unknown[]).at(-1))).toEqual([ITEM]);
		expect(calls(runner.query, 'SET contract_item_id = x.contract_item_id')).toHaveLength(0);
		// La complementaria: id generado en el INSERT = grupo; condiciones propias o las del contrato; montos a moneda del sistema.
		expect(header[0]).toContain('FROM (SELECT gen_random_uuid() AS id) g');
		expect(header[0]).toContain('COALESCE($28::text, (SELECT k.invoice_terms_and_conditions FROM contracts k WHERE k.id = $2::uuid))');
		expect(calls(runner.query, 'COALESCE(hs.system_currency').map(([, params]) => (params as unknown[])[0])).toContainEqual(['inv-new']);
		// La entry apunta a la complementaria; RSM del mes; evento con el vínculo.
		expect(calls(runner.query, 'INSERT INTO consumption_entries')[0][1].at(-1)).toBe('inv-new');
		expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT, '2026-10-01']);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(event[1][2]).toBe('CONSUMPTION_ADDITIONAL_INVOICE');
		expect(event[1][4]).toContain('(complementaria inv-new por CLP 13.5 sobre F-0042)');
		expect(JSON.parse(event[1][8] as string)).toMatchObject({
			mode: 'additional',
			invoice_id: 'inv-new',
			complements_invoice_id: 'inv-paid',
			additional_amount: 13.5,
			already_invoiced: 64.8,
		});
		// Nunca la emitida.
		expect(calls(runner.query, 'UPDATE invoices')).toHaveLength(0);
		expect(calls(runner.query, 'UPDATE invoice_items SET quantity')).toHaveLength(0);
		expect(calls(runner.query, 'DELETE FROM invoice_items')).toHaveLength(0);

		expect(result).toMatchObject({
			mode: 'additional',
			on_issued: 'additional',
			event: 'CONSUMPTION_ADDITIONAL_INVOICE',
			issued_invoice: { id: 'inv-paid', invoice_number: 'F-0042', total: 77.11 },
			additional_amount: 13.5,
			additional_allowed: true,
			additional_reason: null,
			credit_note: null,
			cancelled_invoice: null,
			created: { invoice_id: 'inv-new' },
			invoice: { id: 'inv-new', status: 'Por Emitir', subtotal: 13.5, tax: 2.57, total: 16.07, fx: 1, currency: 'CLP' },
			lines: [{ id: 'line-new-1', quantity: 250, unit_price: 0.054, subtotal: 13.5, tax_amount: 2.57, total: 16.07 }],
			entry: { invoice_id: 'inv-new', quantity: 1250 },
		});
		expect(result.line).toMatchObject({ id: 'line-new-1', invoice_id: 'inv-new', quantity: 250, subtotal: 13.5 });
	});

	it('reissue: la NC copia el IVA guardado de cada línea (exact) y la reemisión copia las glosas escritas a mano bloqueadas', async () => {
		const world = issuedWorld();
		const { service, runner } = build((sql, params) => {
			if (sql.includes('ii.billing_period_start = $3::date'))
				return [paidLine({ description_locked: true, description: 'Rutas (glosa a mano)' })];
			if (sql.includes('FROM invoice_items ii WHERE ii.invoice_id = $1'))
				return paidLines.map((line) =>
					line.id === 'line-other'
						? { ...line, tax_amount_contract_currency: '19.02', tax_amount_invoice_currency: '19.02', description_locked: true }
						: line
				);

			return world(sql, params);
		});

		await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, apply_as: 'reissue' }, HOLDING, 'auth-1');
		const ncLines = runner.query.mock.calls.filter(
			([sql, params]) =>
				(sql as string).includes('INSERT INTO invoice_items') && String((params as unknown[])[4]).includes('NC espejo por reemisión')
		);

		// IVA de la NC = el guardado de cada línea (19,02 y 12,31), no subtotal × tasa (19,00).
		expect(ncLines.map(([, params]) => (params as unknown[])[12])).toEqual([-12.31, -19.02]);
		const newLines = runner.query.mock.calls.filter(
			([sql, params]) => (sql as string).includes('INSERT INTO invoice_items') && (params as unknown[])[0] === 'inv-new'
		);

		expect(newLines.map(([, params]) => [(params as unknown[])[4], (params as unknown[])[25]])).toEqual([
			['Soporte - Periodo 01/10/2026 a 31/10/2026', true],
			['Rutas (glosa a mano)', true],
		]);
	});

	it('additional sin diferencia positiva → 400 no_additional_consumption y nada escrito', async () => {
		const { service, runner } = build(issuedWorld());
		const error = await rejection(
			service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 300, on_issued: 'additional' }, HOLDING, 'auth-1'),
			BadRequestException
		);

		expect(error.getResponse()).toMatchObject({
			code: 'no_additional_consumption',
			additional_allowed: false,
			already_invoiced: 64.8,
			difference: -14.8,
		});
		expect(calls(runner.query, 'INSERT INTO')).toHaveLength(0);
	});

	it('reissue: NC espejo completa de la emitida (issue_error / cancellation, con el estado de la emitida y referencia) + factura nueva del período con las otras líneas intactas y la del ítem recalculada; CONSUMPTION_REISSUE', async () => {
		const { service, runner } = build(issuedWorld());
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, on_issued: 'reissue' }, HOLDING, 'auth-1');
		const [nc] = calls(runner.query, `'NC', $17`);

		// NC: −(64,80 + 100) = −164,80 neto, IVA −31,31, total −196,11; espejo de inv-paid; reason issue_error, type cancellation.
		// Decisión 01-10: la NC nace siempre Emitida (aunque la factura que anula esté Pagada) y referencia su folio (código 1 = anula).
		expect(nc[1][6]).toBe('Emitida');
		expect(nc[0]).toContain('$6, $6, $6, NULL');
		expect(calls(runner.query, 'INSERT INTO invoice_references')[0][1]).toEqual(expect.arrayContaining(['1']));
		expect(nc[1].slice(10, 14)).toEqual([-164.8, -164.8, -31.31, -196.11]);
		expect(nc[1][16]).toBe('inv-paid');
		expect(nc[1][17]).toBe('issue_error');
		expect(nc[1][28]).toBe('cancellation');
		const ncLines = runner.query.mock.calls.filter(
			([sql, params]) =>
				(sql as string).includes('INSERT INTO invoice_items') &&
				String((params as unknown[])[4]).includes('NC espejo por reemisión de F-0042')
		);

		expect(ncLines).toHaveLength(2);
		// Factura nueva: 100 (soporte, intacto) + 78,30 (rutas recalculadas) = 178,30; IVA 33,88; total 212,18.
		const headers = calls(runner.query, 'INSERT INTO invoices').filter(([sql]) => !(sql as string).includes(`'NC'`));

		expect(headers).toHaveLength(1);
		expect(headers[0][1].slice(10, 15)).toEqual([178.3, 178.3, 33.88, 212.18, 1]);
		expect(headers[0][1][28]).toContain('Reemisión de F-0042 por consumo corregido de "Rutas optimizadas"');
		const newLines = runner.query.mock.calls.filter(
			([sql, params]) => (sql as string).includes('INSERT INTO invoice_items') && (params as unknown[])[0] === 'inv-new'
		);

		expect(newLines.map(([, params]) => [(params as unknown[])[4], (params as unknown[])[5], (params as unknown[])[10]])).toEqual([
			['Soporte - Periodo 01/10/2026 a 31/10/2026', 1, 100],
			[
				'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Tramos: gratis 100; 101-500 x 0,08 + fijo 10,00; 501-1.250 x 0,06; descuento -8,70',
				1250,
				78.3,
			],
		]);
		// En la nueva, cada línea nace con su ítem (sin patrón B); la emitida nunca se actualiza.
		expect(newLines.map(([, params]) => (params as unknown[]).at(-1))).toEqual([OTHER_ITEM, ITEM]);
		expect(calls(runner.query, 'SET contract_item_id = x.contract_item_id')).toHaveLength(0);
		// La emitida no se toca: el único UPDATE es el de la NC, en moneda del sistema con la tasa de la original (ROADMAP #10).
		const invoiceUpdates = calls(runner.query, 'UPDATE invoices');

		expect(invoiceUpdates).toHaveLength(1);
		expect(invoiceUpdates[0][0]).toContain('UPDATE invoices n SET fx_contract_to_system = o.fx_contract_to_system');
		expect(invoiceUpdates[0][1]).toEqual(['nc-1', 'inv-paid', 'h-1']);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(event[1][2]).toBe('CONSUMPTION_REISSUE');
		expect(event[1][4]).toContain('(F-0042 anulada con NC nc-1 y reemitida como inv-new)');
		expect(JSON.parse(event[1][8] as string)).toMatchObject({
			mode: 'reissue',
			cancelled_invoice_id: 'inv-paid',
			credit_note_id: 'nc-1',
			invoice_id: 'inv-new',
			lines_count: 2,
		});
		expect(calls(runner.query, 'INSERT INTO consumption_entries')[0][1].at(-1)).toBe('inv-new');

		expect(result).toMatchObject({
			mode: 'reissue',
			on_issued: 'reissue',
			event: 'CONSUMPTION_REISSUE',
			issued_invoice: { id: 'inv-paid', invoice_number: 'F-0042' },
			additional_amount: 13.5,
			additional_allowed: true,
			credit_note: { id: 'nc-1', number: null, total: -196.11 },
			cancelled_invoice: { id: 'inv-paid', invoice_number: 'F-0042' },
			created: { invoice_id: 'inv-new', credit_note_id: 'nc-1' },
			invoice: { id: 'inv-new', status: 'Por Emitir', subtotal: 178.3, tax: 33.88, total: 212.18 },
			lines: [{ id: 'line-new-4', quantity: 1250, subtotal: 78.3 }],
		});
	});

	it('preview con on_issued muestra lo que se crearía sin escribir (complementaria o NC + factura nueva)', async () => {
		const additional = build(issuedWorld());
		const preview = await additional.service.preview(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, on_issued: 'additional' }, HOLDING);

		expect(preview).toMatchObject({
			mode: 'additional',
			additional_amount: 13.5,
			additional_allowed: true,
			issued_invoice: { id: 'inv-paid' },
			invoice: { id: '', status: 'Por Emitir', subtotal: 13.5, total: 16.07 },
			lines: [{ id: null, quantity: 250, subtotal: 13.5 }],
			created: {},
		});
		expect(additional.dataSource.createQueryRunner).not.toHaveBeenCalled();
		const reissue = build(issuedWorld());
		const reissued = await reissue.service.preview(CONTRACT, ITEM, '2026-10-01', { quantity: 1250, on_issued: 'reissue' }, HOLDING);

		expect(reissued).toMatchObject({
			mode: 'reissue',
			credit_note: { id: null, number: null, total: -196.11 },
			cancelled_invoice: { id: 'inv-paid', invoice_number: 'F-0042' },
			invoice: { subtotal: 178.3, total: 212.18 },
			lines: [{ id: null, quantity: 1250, subtotal: 78.3 }],
		});
		expect(calls(reissue.dataSource.query as jest.Mock, 'INSERT INTO')).toHaveLength(0);
	});

	it('corregir un período cuya Por Emitir es la complementaria recalcula solo la diferencia contra la emitida (nunca el total)', async () => {
		const complementaryLine = pendingLine({
			line_id: 'line-comp',
			invoice_id: 'inv-comp',
			quantity: '250',
			subtotal_contract_currency: '13.50',
			description: 'Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Consumo adicional sobre F-0042',
			pricing_breakdown: [{ kind: 'invoiced', quantity: 1000, amount: -64.8, label: 'Ya facturado en F-0042', invoice_id: 'inv-paid' }],
		});
		const existing = {
			id: 'entry-1',
			contract_item_id: ITEM,
			period_start: '2026-10-01',
			period_end: '2026-10-31',
			quantity: '1250',
			amount_override: null,
			apply_item_discount: true,
			account: null,
			is_estimated: false,
			source: 'manual',
			revision: 1,
			correction_reason: null,
			notes: null,
			idempotency_key: null,
			invoice_id: 'inv-comp',
		};
		const { service, runner } = build((sql) => {
			if (sql.includes('ii.billing_period_start = $3::date')) return [paidLine(), complementaryLine];
			if (sql.includes('FROM consumption_entries e WHERE e.contract_item_id')) return [existing];

			return undefined;
		});
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1400, correction_reason: 'Reporte final' }, HOLDING, 'auth-1');
		const [lineUpdate] = calls(runner.query, 'UPDATE invoice_items SET quantity');

		// 1.400 rutas → 80,00 (tope) − 64,80 emitido = 15,20 en 400 unidades adicionales (0,038).
		expect(lineUpdate[1].slice(0, 6)).toEqual(['line-comp', HOLDING, 400, 0.038, 0.038, 15.2]);
		expect(JSON.parse(lineUpdate[1][11] as string).at(-1)).toMatchObject({ kind: 'invoiced', amount: -64.8, invoice_id: 'inv-paid' });
		expect(lineUpdate[1][14]).toBe('Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Consumo adicional sobre F-0042');
		expect(result).toMatchObject({
			mode: 'recompute',
			event: 'CONSUMPTION_CORRECTED',
			issued_invoice: { id: 'inv-paid', invoice_number: 'F-0042' },
			additional_amount: 15.2,
			additional_allowed: true,
			invoice: { id: 'inv-comp' },
		});
		expect(result.warnings.some((warning) => warning.includes('complementaria de F-0042'))).toBe(true);
		expect(calls(runner.query, 'INSERT INTO invoices')).toHaveLength(0);
	});

	it('per_tier: el recálculo reemplaza el conjunto de filas del ítem en la Por Emitir (DELETE + INSERT con el ítem) y el encabezado = Σ líneas', async () => {
		const { service, runner } = build((sql) => {
			if (sql.includes('WHERE ci.id = $1::uuid')) return [{ ...meteredItemRow, price_invoice_line_mode: 'per_tier' }];
			if (sql.includes('ii.billing_period_start = $3::date')) return [pendingLine({ product_id: 'prod-1', unit_of_measure: 'ruta' })];
			if (sql.includes('INSERT INTO invoice_items')) return [{ id: `line-new-${++sequence}` }];
			if (sql.includes('SELECT contract_id FROM invoices')) return [{ contract_id: CONTRACT }];

			return undefined;
		});
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1');

		expect(calls(runner.query, 'UPDATE invoice_items SET quantity')).toHaveLength(0);
		expect(calls(runner.query, 'DELETE FROM invoice_items')[0][1]).toEqual([['line-oct'], 'inv-oct', HOLDING, ITEM]);
		const inserts = calls(runner.query, 'INSERT INTO invoice_items');

		expect(
			inserts.map(([, params]) => [
				(params as unknown[])[4],
				(params as unknown[])[5],
				(params as unknown[])[8],
				(params as unknown[])[10],
				(params as unknown[])[12],
			])
		).toEqual([
			['Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Tramo 1 (1-500)', 400, 0.105, 42, 7.98],
			['Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Tramo 2 (501-2.000)', 750, 0.06, 45, 8.55],
			['Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Descuento del ítem 10 %', 1, -8.7, -8.7, -1.65],
		]);
		expect(JSON.parse(inserts[0][1][24] as string)).toEqual([
			expect.objectContaining({ kind: 'free', period_quantity: 1250, line_index: 0, line_count: 3 }),
			expect.objectContaining({ kind: 'tier', amount: 42 }),
		]);
		expect(inserts.map(([, params]) => (params as unknown[]).at(-1))).toEqual([ITEM, ITEM, ITEM]);
		expect(calls(runner.query, 'SET contract_item_id = x.contract_item_id')).toHaveLength(0);
		expect(calls(runner.query, 'UPDATE invoices SET amount_contract_currency')[0][1]).toEqual([
			'inv-oct',
			HOLDING,
			178.3,
			33.88,
			178.3,
			212.18,
			19,
		]);
		expect(result.lines.map((line) => [line.id, line.part?.part, line.subtotal])).toEqual([
			['line-new-1', 'charge', 42],
			['line-new-2', 'charge', 45],
			['line-new-3', 'adjustment', -8.7],
		]);
		expect(result.line).toMatchObject({ id: 'line-new-1', quantity: 1250, subtotal: 78.3, tax_amount: 14.88, total: 93.18 });
	});

	it('single sobre filas per_tier anteriores: actualiza la primera y borra las sobrantes', async () => {
		const tierLine = (id: string, index: number) =>
			pendingLine({
				line_id: id,
				pricing_breakdown: [{ kind: 'tier', quantity: 1, amount: 1, label: 'T', period_quantity: 1000, line_index: index, line_count: 2 }],
			});
		const { service, runner } = build((sql) =>
			sql.includes('ii.billing_period_start = $3::date') ? [tierLine('l-b', 1), tierLine('l-a', 0)] : undefined
		);

		await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1');
		expect(calls(runner.query, 'UPDATE invoice_items SET quantity')[0][1][0]).toBe('l-a');
		expect(calls(runner.query, 'DELETE FROM invoice_items')[0][1]).toEqual([['l-b'], 'inv-oct', HOLDING, ITEM]);
	});
});

describe('ConsumptionService.preview y bulk', () => {
	it('preview devuelve la línea recalculada y la factura destino sin escribir; los 409 se devuelven igual', async () => {
		const { service, runner, dataSource } = build();
		const result = await service.preview(CONTRACT, ITEM, '2026-10-01', { quantity: 1400 }, HOLDING);

		expect(result).toMatchObject({
			entry: { id: null, quantity: 1400, revision: 1, period_end: '2026-10-31' },
			line: { id: 'line-oct', subtotal: 80, quantity_source: 'consumption' },
			invoice: { id: 'inv-oct', status: 'Por Emitir' },
			event: 'CONSUMPTION_RECORDED',
			would_correct: false,
		});
		expect(result.line?.breakdown.at(-1)).toMatchObject({ kind: 'cap', amount: -6.4 });
		expect(runner.startTransaction).not.toHaveBeenCalled();
		expect((dataSource.query as jest.Mock).mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql as string))).toBe(false);
		await rejection(service.preview(CONTRACT, ITEM, '2026-12-01', { quantity: 1 }, HOLDING), ConflictException);
	});

	it('bulk: una transacción por fila, resuelve el ítem por id o por producto + cuenta y reporta skipped con motivo', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('SELECT ci.id, ci.product_name, ci.account FROM contract_items ci')
				? [
						{ id: ITEM, product_name: 'Rutas optimizadas', account: null },
						{ id: OTHER_ITEM, product_name: 'Soporte', account: 'Norte' },
					]
				: undefined
		);
		const result = await service.bulk(
			CONTRACT,
			{
				rows: [
					{ item_id: ITEM, period_start: '2026-10-01', quantity: 1250 },
					{ product_name: 'rutas optimizadas', period_start: '2026-10-01', quantity: 1300 },
					{ product_name: 'Soporte', account: 'Norte', period_start: '2026-10-01', quantity: 5 },
					{ period_start: '2026-10-01', quantity: 5 },
					{ item_id: ITEM, period_start: '2026-12-01', quantity: 5 },
				],
			},
			HOLDING,
			'auth-1'
		);

		expect(result.applied).toBe(2);
		expect(result.results.map((row) => [row.row, row.item_id, row.event])).toEqual([
			[0, ITEM, 'CONSUMPTION_RECORDED'],
			[1, ITEM, 'CONSUMPTION_RECORDED'],
		]);
		expect(result.skipped).toEqual([
			{ row: 2, reason: 'El ítem no pertenece al contrato' },
			{ row: 3, reason: 'Indica el ítem (item_id) o el producto con su cuenta' },
			{ row: 4, reason: expect.stringContaining('no tiene un período de servicio que empiece el 2026-12-01') },
		]);
		// Filas 0, 1, 2 y 4 abren transacción (la 3 falla antes, sin ítem); solo 0 y 1 confirman; el resto revierte.
		expect(runner.startTransaction).toHaveBeenCalledTimes(4);
		expect(runner.commitTransaction).toHaveBeenCalledTimes(2);
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(2);
		expect(calls(runner.query, 'INSERT INTO consumption_entries')[0][1][10]).toBe('csv');
	});
});

describe('ConsumptionService.pending y list', () => {
	it('pendientes: filtra Por Emitir activas, medidas, pending y período terminado; paginado { data, total, currentPage, pages, limit } con filtros', async () => {
		const { service, dataSource } = build((sql) => {
			if (sql.includes('SELECT COUNT(*) AS total')) return [{ total: '3' }];
			if (sql.includes('bm.aggregation AS metric_aggregation') && sql.includes('LIMIT'))
				return [
					{
						line_id: 'line-oct',
						billing_period_start: '2026-10-01',
						billing_period_end: '2026-10-31',
						quantity: '1000',
						subtotal_contract_currency: '64.80',
						invoice_id: 'inv-oct',
						invoice_number: null,
						issue_date: '2026-11-01',
						status: 'Por Emitir',
						contract_currency: 'CLF',
						invoice_currency: 'CLP',
						contract_id: CONTRACT,
						contract_number: 'CTR-2026-001',
						client_id: 'cl-1',
						client_name: 'ACME',
						company_id: 'co-1',
						item_id: ITEM,
						product_name: 'Rutas optimizadas',
						account: null,
						unit_of_measure: 'ruta',
						metric_id: 'm-1',
						metric_code: 'rutas',
						metric_name: 'Rutas completadas',
						metric_unit: 'ruta',
						metric_aggregation: 'sum',
					},
				];

			return undefined;
		});
		const result = await service.pending(
			HOLDING,
			{ period: '2026-10', client_id: 'cl-1', page: 2, limit: 2 },
			undefined,
			new Date('2026-11-10T12:00:00.000Z')
		);

		expect(result).toMatchObject({ total: 3, currentPage: 2, pages: 2, limit: 2 });
		expect(result.data[0]).toMatchObject({
			period_start: '2026-10-01',
			base_quantity: 1000,
			base_amount: 64.8,
			contract: { id: CONTRACT, contract_number: 'CTR-2026-001', client_name: 'ACME' },
			item: { id: ITEM, product_name: 'Rutas optimizadas' },
			metric: { code: 'rutas', unit: 'ruta' },
			invoice: { id: 'inv-oct', status: 'Por Emitir', issue_date: '2026-11-01' },
		});
		const [sql, params] = (dataSource.query as jest.Mock).mock.calls.find(([text]) => (text as string).includes('LIMIT 2 OFFSET 2'))!;

		expect(sql).toContain(`i.status = 'Por Emitir'`);
		expect(sql).toContain(`p.quantity_type = 'metered'`);
		expect(sql).toContain(`ii.quantity_source = 'pending'`);
		expect(sql).toContain('ii.billing_period_end < $2::date');
		expect(sql).toContain(`i.invoice_type IS DISTINCT FROM 'Unificada'`);
		expect(sql).toContain(`i.document_type IS DISTINCT FROM 'NC'`);
		expect(params).toEqual([HOLDING, '2026-11-10', '2026-10', 'cl-1']);

		await service.pending(HOLDING, {}, CONTRACT);
		const scoped = (dataSource.query as jest.Mock).mock.calls.find(([text]) => (text as string).includes('c.id = $3::uuid'))!;

		expect(scoped[1]).toEqual([HOLDING, expect.any(String), CONTRACT]);
		// `?contract_id=` en la ruta del holding acota igual que la ruta por contrato.
		(dataSource.query as jest.Mock).mockClear();
		await service.pending(HOLDING, { contract_id: CONTRACT, company_id: 'co-1' });
		const byQuery = (dataSource.query as jest.Mock).mock.calls.find(([text]) => (text as string).includes('c.id = $3::uuid'))!;

		expect(byQuery[0]).toContain('c.company_id = $4::uuid');
		expect(byQuery[1]).toEqual([HOLDING, expect.any(String), CONTRACT, 'co-1']);
	});

	it('list: cada entry trae quién y cuándo la registró y sus revisiones (más nuevas primero, máximo 20)', async () => {
		const revisions = Array.from({ length: 25 }, (_, index) => ({
			entry_id: 'e-1',
			revision: 25 - index,
			quantity: String(1000 + index),
			amount_override: null,
			reason: index === 0 ? 'ajuste' : null,
			changed_at: new Date('2026-10-03T10:00:00.000Z'),
			recorded_by_id: index === 0 ? 'u-1' : null,
			recorded_by_name: index === 0 ? 'Domi' : null,
		}));
		const { service, dataSource } = build((sql) => {
			if (sql.includes('FROM consumption_entries e') && sql.includes('LEFT JOIN users u'))
				return [
					{
						id: 'e-1',
						contract_item_id: ITEM,
						period_start: '2026-10-01',
						period_end: '2026-10-31',
						quantity: '1250',
						revision: 25,
						source: 'manual',
						apply_item_discount: true,
						is_estimated: false,
						updated_at: new Date('2026-10-03T10:00:00.000Z'),
						recorded_by_id: 'u-1',
						recorded_by_name: 'Domi',
						revisions_count: '25',
					},
				];
			if (sql.includes('FROM consumption_entry_revisions r')) return revisions;

			return undefined;
		});
		const result = await service.list('CTR-2026-001', HOLDING);

		const row = result.rows[0];

		if (row.kind !== 'entry') throw new Error('se esperaba una fila entry');
		expect(row).toMatchObject({
			id: 'e-1',
			recorded_by: { id: 'u-1', name: 'Domi' },
			recorded_at: '2026-10-03T10:00:00.000Z',
			revisions_count: 25,
		});
		expect(row.revisions).toHaveLength(20);
		expect(row.revisions[0]).toEqual({
			revision: 25,
			quantity: 1000,
			amount_override: null,
			correction_reason: 'ajuste',
			recorded_by: { id: 'u-1', name: 'Domi' },
			recorded_at: '2026-10-03T10:00:00.000Z',
		});
		expect(row.revisions[19]).toMatchObject({ revision: 6, recorded_by: null });
		const revisionsSql = (dataSource.query as jest.Mock).mock.calls.find(([sql]) =>
			(sql as string).includes('JOIN consumption_entries e ON e.id = r.entry_id')
		)![0] as string;

		expect(revisionsSql).toContain('ORDER BY r.entry_id, r.revision DESC');
		expect(revisionsSql).toContain('LEFT JOIN users u ON u.id = r.changed_by');
	});

	it('list acota todo al contrato y al holding y delega en buildConsumption (entries + quantities + ítems + líneas)', async () => {
		const { service, dataSource, contracts } = build();
		const result = await service.list('CTR-2026-001', HOLDING);

		expect(contracts.resolveContract).toHaveBeenCalledWith('CTR-2026-001', HOLDING);
		expect(result).toEqual({ uses_usage_pricing: false, rows: [], items: [], pending: [] });
		for (const [sql, params] of (dataSource.query as jest.Mock).mock.calls) {
			expect(params).toEqual([CONTRACT, HOLDING]);
			expect(sql).toMatch(/holding_id = \$2/);
		}
		expect((dataSource.query as jest.Mock).mock.calls.some(([sql]) => (sql as string).includes('FROM quantities q'))).toBe(true);
		expect((dataSource.query as jest.Mock).mock.calls.some(([sql]) => (sql as string).includes('FROM consumption_entries e'))).toBe(true);
	});
});

describe('DTOs de consumo', () => {
	const check = async (type: new () => object, body: unknown) =>
		flattenValidationErrors(await validate(plainToInstance(type, body), { whitelist: true, forbidNonWhitelisted: true })).map(
			(error) => `${error.field}: ${error.message}`
		);

	it('UpsertConsumptionDto: cantidad ≥ 0 obligatoria, monto informado ≥ 0, textos acotados, nada de holding_id', async () => {
		expect(await check(UpsertConsumptionDto, { quantity: 0 })).toEqual([]);
		expect(
			await check(UpsertConsumptionDto, {
				quantity: 1250,
				amount_override: null,
				apply_item_discount: false,
				account: ' Norte ',
				notes: 'x',
				correction_reason: 'y',
				idempotency_key: 'k',
			})
		).toEqual([]);
		expect(await check(UpsertConsumptionDto, { quantity: -1, amount_override: -5, holding_id: 'h' })).toEqual([
			'holding_id: property holding_id should not exist',
			'quantity: La cantidad no puede ser negativa',
			'amount_override: El monto informado no puede ser negativo',
		]);
		expect(await check(UpsertConsumptionDto, {})).toEqual(['quantity: La cantidad no puede ser negativa']);
	});

	it('UpsertConsumptionDto.apply_as: recompute | additional | reissue, opcional; on_issued (block | additional | reissue) sigue aceptándose como alias', async () => {
		for (const apply_as of ['recompute', 'additional', 'reissue']) {
			expect(await validate(plainToInstance(UpsertConsumptionDto, { quantity: 1, apply_as }))).toEqual([]);
		}
		expect(await validate(plainToInstance(UpsertConsumptionDto, { quantity: 1, on_issued: 'additional' }))).toEqual([]);
		expect(await validate(plainToInstance(UpsertConsumptionDto, { quantity: 1, apply_as: 'additional', on_issued: 'block' }))).toEqual([]);
		const bad = flattenValidationErrors(await validate(plainToInstance(UpsertConsumptionDto, { quantity: 1, apply_as: 'block' })));

		expect(bad).toEqual([{ field: 'apply_as', message: 'apply_as debe ser recompute, additional o reissue' }]);
		const badAlias = flattenValidationErrors(await validate(plainToInstance(UpsertConsumptionDto, { quantity: 1, on_issued: 'anular' })));

		expect(badAlias).toEqual([{ field: 'on_issued', message: 'on_issued debe ser block, additional o reissue' }]);
	});

	it('ConsumptionBulkDto: 1–500 filas con período YYYY-MM-DD y cantidad; QueryConsumptionPendingDto: período YYYY-MM y paginación', async () => {
		expect(await check(ConsumptionBulkDto, { rows: [] })).toEqual(['rows: Agrega al menos una fila']);
		expect(await check(ConsumptionBulkDto, { rows: [{ product_name: 'Rutas', period_start: '2026-10-1', quantity: 'x' }] })).toEqual([
			'rows.0.period_start: Período inválido (YYYY-MM-DD)',
			'rows.0.quantity: La cantidad no puede ser negativa',
		]);
		expect(
			await check(ConsumptionBulkDto, { rows: Array.from({ length: 501 }, () => ({ item_id: ITEM, period_start: '2026-10-01', quantity: 1 })) })
		).toEqual(['rows: Máximo 500 filas por importación']);
		expect(await check(QueryConsumptionPendingDto, { period: '2026-10', page: '2', limit: '50', contract_id: CONTRACT })).toEqual([]);
		expect(await check(QueryConsumptionPendingDto, { contract_id: 'x' })).toEqual(['contract_id: Contrato inválido']);
		expect(await check(QueryConsumptionPendingDto, { period: '2026-10-01', limit: 500 })).toEqual([
			'period: Período inválido (YYYY-MM)',
			'limit: Máximo 200 por página',
		]);
	});
});

describe('controladores de consumo', () => {
	it('ConsumptionController: guards, ruta /consumption/pending y holding del guard', async () => {
		const consumption = {
			pending: jest.fn().mockResolvedValue({ data: [], total: 0, currentPage: 1, pages: 1, limit: 25 }),
		} as unknown as ConsumptionService;
		const controller = new ConsumptionController(consumption);

		expect(Reflect.getMetadata(GUARDS_METADATA, ConsumptionController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		expect(Reflect.getMetadata(PATH_METADATA, ConsumptionController)).toBe('consumption');
		expect(Reflect.getMetadata(PATH_METADATA, ConsumptionController.prototype.pending)).toBe('pending');
		await controller.pending({ period: '2026-10' }, HOLDING);
		expect(consumption.pending).toHaveBeenCalledWith(HOLDING, { period: '2026-10' });
	});

	it('ContractsController: las rutas de consumo pasan contrato, ítem, período, holding y usuario; preview/bulk responden 200', async () => {
		const consumption = {
			list: jest.fn().mockResolvedValue({}),
			pending: jest.fn().mockResolvedValue({}),
			preview: jest.fn().mockResolvedValue({}),
			bulk: jest.fn().mockResolvedValue({}),
			upsert: jest.fn().mockResolvedValue({}),
		} as unknown as ConsumptionService;
		const contracts = { resolveContract: jest.fn().mockResolvedValue({ id: CONTRACT }) } as unknown as ContractsService;
		const controller = new ContractsController(
			contracts,
			{} as ContractDraftsService,
			{} as ContractSubscriptionsService,
			{} as Contract360Service,
			{} as ContractBulkService,
			{} as ContractActivationService,
			consumption,
			{} as ContractChangesService,
			{} as ContractInvoicesService,
			{} as ContractInvoiceDescriptionsService,

			{} as ContractInvoiceEditService,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never,
			{} as never
		);
		const req = { user: { sub: 'auth-1' } };

		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.consumptionPreview)).toBe(200);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.consumptionBulk)).toBe(200);
		expect(Reflect.getMetadata(PATH_METADATA, ContractsController.prototype.upsertConsumption)).toBe(
			':id/items/:itemId/consumption/:periodStart'
		);
		expect(Reflect.getMetadata(PATH_METADATA, ContractsController.prototype.consumptionPending)).toBe(':id/consumption/pending');

		await controller.consumption('CTR-1', HOLDING);
		expect(consumption.list).toHaveBeenCalledWith('CTR-1', HOLDING);
		await controller.consumptionPending('CTR-1', { period: '2026-10' }, HOLDING);
		expect(consumption.pending).toHaveBeenCalledWith(HOLDING, { period: '2026-10' }, CONTRACT);
		await controller.consumptionPreview('CTR-1', { item_id: ITEM, period_start: '2026-10-01', quantity: 5 }, HOLDING);
		expect(consumption.preview).toHaveBeenCalledWith(
			'CTR-1',
			ITEM,
			'2026-10-01',
			{ item_id: ITEM, period_start: '2026-10-01', quantity: 5 },
			HOLDING
		);
		await controller.consumptionBulk('CTR-1', { rows: [] }, HOLDING, req);
		expect(consumption.bulk).toHaveBeenCalledWith('CTR-1', { rows: [] }, HOLDING, 'auth-1');
		await controller.upsertConsumption('CTR-1', ITEM, '2026-10-01', { quantity: 5 }, HOLDING, req);
		expect(consumption.upsert).toHaveBeenCalledWith('CTR-1', ITEM, '2026-10-01', { quantity: 5 }, HOLDING, 'auth-1');
	});
});

describe('ConsumptionService · ediciones manuales, glosas protegidas y sin cobro (spec facturas §3.4)', () => {
	let sequence = 0;
	const standard = (overrides: Row = {}) => pendingLine({ ...standardLine, discount_pct: '0', ...overrides });
	const withStandardItem =
		(lines: Row[], extra: Handler = () => undefined): Handler =>
		(sql, params) => {
			const custom = extra(sql, params);

			if (custom !== undefined) return custom;
			if (sql.includes('WHERE ci.id = $1::uuid')) return [standardItemRow];
			if (sql.includes('ii.billing_period_start = $3::date')) return lines;
			if (sql.includes('SELECT contract_id FROM invoices')) return [{ contract_id: CONTRACT }];

			return undefined;
		};

	it('una línea editada a mano (quantity_source = manual) no se recalcula: el consumo se guarda y se avisa manual_edit_kept', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('ii.billing_period_start = $3::date') ? [pendingLine({ quantity_source: 'manual' })] : undefined
		);
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1');

		expect(calls(runner.query, 'UPDATE invoice_items')).toHaveLength(0);
		expect(calls(runner.query, 'DELETE FROM invoice_items')).toHaveLength(0);
		expect(calls(runner.query, 'INSERT INTO consumption_entries')).toHaveLength(1);
		expect(result).toMatchObject({ mode: 'none', invoice: null, warning_codes: ['manual_edit_kept'] });
		expect(result.warnings.some((warning) => warning.includes('editada a mano'))).toBe(true);
	});

	it('per_tier: al reinsertar las filas conserva la glosa protegida en la fila del mismo tramo (line_index)', async () => {
		const tier = (id: string, index: number, overrides: Row = {}) =>
			pendingLine({
				line_id: id,
				description: `Tramo ${index}`,
				pricing_breakdown: [{ kind: 'tier', quantity: 1, amount: 1, label: 'T', period_quantity: 1000, line_index: index, line_count: 2 }],
				...overrides,
			});
		const { service, runner } = build((sql) => {
			if (sql.includes('WHERE ci.id = $1::uuid')) return [{ ...meteredItemRow, price_invoice_line_mode: 'per_tier' }];
			if (sql.includes('ii.billing_period_start = $3::date'))
				return [tier('l-b', 1), tier('l-a', 0, { description: 'Rutas de octubre (texto del cliente)', description_locked: true })];
			if (sql.includes('INSERT INTO invoice_items')) return [{ id: `line-new-${++sequence}` }];
			if (sql.includes('SELECT contract_id FROM invoices')) return [{ contract_id: CONTRACT }];

			return undefined;
		});

		await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 1250 }, HOLDING, 'auth-1');
		const inserts = calls(runner.query, 'INSERT INTO invoice_items').map(([, params]) => params as unknown[]);

		expect(inserts.map((params) => [params[4], params[25]])).toEqual([
			['Rutas de octubre (texto del cliente)', true],
			['Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Tramo 2 (501-2.000)', false],
			['Rutas optimizadas - Periodo 01/10/2026 a 31/10/2026 - Descuento del ítem 10 %', false],
		]);
		expect(inserts.every((params) => params.at(-1) === ITEM)).toBe(true);
	});

	it('ida y vuelta: consumo 0 deja la factura sin cobro (Cancelada + INVOICE_NO_CHARGE) y un consumo > 0 la devuelve a Por Emitir recalculada', async () => {
		const zero = build(withStandardItem([standard({ other_nonzero_lines: '0' })]));
		const cancelled = await zero.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 0 }, HOLDING, 'auth-1');
		const toCancelled = calls(zero.runner.query, "UPDATE invoices SET status = 'Cancelada'");

		expect(calls(zero.runner.query, 'UPDATE invoice_items SET quantity')[0][1].slice(0, 3)).toEqual(['line-oct', HOLDING, 0]);
		expect(toCancelled).toHaveLength(1);
		expect(toCancelled[0][1]).toEqual(['inv-oct', HOLDING]);
		// El encabezado se recalcula ANTES de cancelar (su UPDATE solo toca Por Emitir).
		const sql = zero.runner.query.mock.calls.map(([statement]) => statement as string);

		expect(sql.findIndex((statement) => statement.includes('UPDATE invoices SET amount_contract_currency'))).toBeLessThan(
			sql.findIndex((statement) => statement.includes("SET status = 'Cancelada'"))
		);
		const noChargeEvent = calls(zero.runner.query, 'INSERT INTO contract_lifecycle_events').find(
			([, params]) => (params as unknown[])[2] === 'INVOICE_NO_CHARGE'
		);

		expect(JSON.parse((noChargeEvent![1] as unknown[])[7] as string)).toMatchObject({
			invoice_id: 'inv-oct',
			reason: 'zero_consumption',
			before: { status: 'Por Emitir' },
			after: { status: 'Cancelada' },
			period: { start: '2026-10-01', end: '2026-10-31' },
		});
		expect(cancelled).toMatchObject({ mode: 'recompute', invoice: { id: 'inv-oct', status: 'Cancelada' }, warning_codes: ['becomes_no_charge'] });
		expect(calls(zero.runner.query, 'DELETE FROM invoice_items')).toHaveLength(0);

		const back = build(
			withStandardItem([
				standard({ status: 'Cancelada', no_charge: true, quantity: '0', subtotal_contract_currency: '0', other_nonzero_lines: '0' }),
			])
		);
		const restored = await back.service.upsert(
			CONTRACT,
			ITEM,
			'2026-10-01',
			{ quantity: 2, correction_reason: 'Sí hubo servicio' },
			HOLDING,
			'auth-1'
		);
		const backSql = back.runner.query.mock.calls.map(([statement]) => statement as string);
		const toPending = backSql.findIndex((statement) => statement.includes("UPDATE invoices SET status = 'Por Emitir'"));

		expect(toPending).toBeGreaterThan(-1);
		expect(toPending).toBeLessThan(backSql.findIndex((statement) => statement.includes('UPDATE invoices SET amount_contract_currency')));
		expect(calls(back.runner.query, 'UPDATE invoice_items SET quantity')[0][1].slice(0, 6)).toEqual(['line-oct', HOLDING, 2, 100, 100, 200]);
		expect(
			calls(back.runner.query, 'INSERT INTO contract_lifecycle_events').some(
				([, params]) => (params as unknown[])[2] === 'INVOICE_NO_CHARGE_REVERTED'
			)
		).toBe(true);
		expect(restored).toMatchObject({ mode: 'recompute', invoice: { status: 'Por Emitir' }, warning_codes: ['no_charge_reverted'] });
	});

	it('una línea en 0 con otras líneas con monto no cancela la factura; otra cancelada (no sin cobro) nunca se reactiva', async () => {
		const partial = build(withStandardItem([standard({ other_nonzero_lines: '2' })]));
		const kept = await partial.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 0 }, HOLDING, 'auth-1');

		expect(calls(partial.runner.query, 'SET status')).toHaveLength(0);
		expect(kept).toMatchObject({ invoice: { status: 'Por Emitir' }, warning_codes: [] });
		const other = build(withStandardItem([standard({ status: 'Cancelada', no_charge: false })]));
		const result = await other.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 5 }, HOLDING, 'auth-1');

		expect(result).toMatchObject({ mode: 'none', invoice: null });
		expect(calls(other.runner.query, 'UPDATE invoice')).toHaveLength(0);
	});

	it('borrador en el ERP no bloquea (decisión 01-10): recalcula, pasa a sin cobro y avisa erp_draft_stale en preview y resultado', async () => {
		const { service, runner } = build(withStandardItem([standard({ odoo_invoice_id: 9, other_nonzero_lines: '0' })]));
		const result = await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 0 }, HOLDING, 'auth-1');

		expect(result.warning_codes).toEqual(['erp_draft_stale', 'becomes_no_charge']);
		expect(result.warnings[0]).toContain(
			'La factura ya tiene un borrador en el ERP: elimínalo allí y restablece el borrador aquí para reenviarla'
		);
		expect(runner.commitTransaction).toHaveBeenCalled();
		const sent = build(withStandardItem([standard({ odoo_invoice_id: null, sent_to_odoo_at: '2026-09-30T10:00:00Z' })]));
		const preview = await sent.service.preview(CONTRACT, ITEM, '2026-10-01', { quantity: 3 }, HOLDING);

		expect(preview.warning_codes).toContain('erp_draft_stale');
	});

	it('write: el contrato se bloquea (FOR UPDATE) justo después de la costura; período cerrado → 409 period_closed sin escribir', async () => {
		const { service, runner } = build(withStandardItem([standard()]));

		await service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 3 }, HOLDING, 'auth-1');
		const sql = runner.query.mock.calls.map(([query]) => query as string);

		expect(sql[0]).toContain('sapira.writer');
		expect(sql[1]).toContain('FROM contracts c');
		expect(sql[1]).toContain('FOR UPDATE');
		const closed = build(
			withStandardItem([standard()], (query) => (query.includes('get_cutoff_date') ? [{ id: CONTRACT, cutoff_date: '2026-10-31' }] : undefined))
		);
		const error = await rejection(closed.service.upsert(CONTRACT, ITEM, '2026-10-01', { quantity: 3 }, HOLDING, 'auth-1'), ConflictException);

		expect((error.getResponse() as Row).blockers).toEqual([expect.objectContaining({ code: 'period_closed', next_step: expect.any(String) })]);
		expect(closed.runner.commitTransaction).not.toHaveBeenCalled();
		expect(calls(closed.runner.query, 'INSERT INTO')).toHaveLength(0);
		// Período abierto pero la Por Emitir (anticipada) se emite en un mes cerrado (emisión 25-09, cierre 30-09) → también 409; el preview igual.
		const issue = build(
			withStandardItem([standard({ issue_date: '2026-09-25' })], (query) =>
				query.includes('get_cutoff_date') ? [{ id: CONTRACT, cutoff_date: '2026-09-30' }] : undefined
			)
		);

		await expect(issue.service.preview(CONTRACT, ITEM, '2026-10-01', { quantity: 3 }, HOLDING)).rejects.toBeInstanceOf(ConflictException);
		expect(consumptionPeriodClosed('2026-11-15', '2026-12-01', '2026-11-01')).toMatchObject({ code: 'period_closed' });
		expect(consumptionPeriodClosed('2026-09-30', '2026-10-01', '2026-11-01')).toBeNull();
		expect(consumptionPeriodClosed(null, '2026-10-01', '2026-11-01')).toBeNull();
	});
});

describe('fitConsumptionGlosa (glosas del consumo ajustadas al límite, decisión 30-09)', () => {
	const context = {
		line_kind: 'per_tier' as const,
		product_name: 'Plataforma de optimizacion de rutas de ultima milla para flota refrigerada',
		account: 'Santiago Centro',
		period_start: '2026-10-01',
		period_end: '2026-10-31',
		tier_label: 'Tramo 1 (1-500)',
	};
	const legacy = asciiGlosa(
		`${lineDescription(context.product_name, context.account, context.period_start, context.period_end)} - Tramo 1 (1-500)`
	);

	it('si la glosa de hoy cabe va tal cual; si no, se ajusta y cuenta', () => {
		const counter = { count: 0 };

		expect(fitConsumptionGlosa(legacy, DEFAULT_TEMPLATE, context, null, counter)).toBe(legacy);
		expect(fitConsumptionGlosa(legacy, DEFAULT_TEMPLATE, context, 200, counter)).toBe(legacy);
		expect(counter.count).toBe(0);
		const fitted = fitConsumptionGlosa(legacy, DEFAULT_TEMPLATE, context, 80, counter);

		expect(legacy.length).toBeGreaterThan(80);
		expect(fitted.length).toBeLessThanOrEqual(80);
		expect(fitted.endsWith('oct-26 - Tramo 1 (1-500)')).toBe(true);
		expect(counter.count).toBe(1);
	});
});
