// `InvoiceSchedulerService` (envío al ERP desde el Contrato 360) importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { GUARDS_METADATA, HTTP_CODE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { flattenValidationErrors } from '@/core/utils/validation-errors';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import * as entityWriter from '@/modules/clients/client-entity-writer';

import { ConsumptionService } from './consumption.service';
import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractChangesService, requestHash } from './contract-changes.service';
import { CONTRACT_ID, HOLDING, LICENCIA, PRODUCT_LICENCIA, PRODUCT_SOPORTE, SOPORTE } from './contract-changes.test-fixtures';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractSubscriptionsService } from './contract-subscriptions.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ContractChangeRequestDto } from './dtos/contract-changes.dto';

type Row = Record<string, unknown>;
type Handler = (sql: string, params: unknown[]) => unknown[] | undefined;

/** Filas de la base tal como las devuelve `loadContext` (mismo contrato de los fixtures puros). */
const contractDbRow: Row = {
	id: CONTRACT_ID,
	contract_number: 'CTR-2026-001',
	status: 'Activo',
	client_id: 'client-1',
	client_entity_id: 'entity-1',
	company_id: 'company-1',
	quote_id: null,
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	system_currency: 'CLP',
	contract_company_currency: 'CLP',
	fx_invoice_policy: 'spot',
	fx_company_policy: null,
	group_invoices_by_period: true,
	auto_invoice: false,
	auto_send_to_odoo: false,
	requires_references_for_billing: false,
	billing_anchor_day: 1,
	payment_terms: { kind: 'net', days: 30 },
	document_type: 'FACTURA',
	tax_document_type_id: null,
	tax_document_type_kind: null,
	invoice_terms_and_conditions: null,
	total_value: '14400',
	contract_end_date: '2026-12-31',
	company_legal_name: 'Simplit SpA',
	company_tax_id: '76.000.000-0',
	company_address: 'Av. Siempre Viva 123',
	company_country: 'Chile',
	company_tax_rate: '19',
	company_currency: 'CLP',
	entity_id: 'entity-1',
	entity_legal_name: 'Cliente SpA',
	entity_tax_id: '77.777.777-7',
	entity_country: 'Chile',
	entity_payment_terms: { kind: 'net', days: 60 },
	fx_invoice_rates: [],
	cutoff_date: null,
};
const itemDbRows: Row[] = [
	{
		id: LICENCIA,
		product_id: PRODUCT_LICENCIA,
		product_name: 'Licencia',
		account: null,
		item_type: 'Recurrente',
		categoria: 'NEW',
		unit_of_measure: 'Usuarios',
		quantity: '10',
		unit_price: '100',
		price_entry_mode: 'monthly',
		annual_unit_price: '1200',
		discount_type: null,
		discount_value: '0',
		monthly_price: '1000',
		billing_period_price: '1000',
		price: '12000',
		final_price: '12000',
		term_months: 12,
		billing_frequency: 'Mensual',
		billing_method: 'Anticipado',
		is_recurring: true,
		start_date: '2026-01-01',
		end_date: '2026-12-31',
		booking_date: '2026-01-01',
		churn_date: null,
		related_item_id: null,
		renews_item_id: null,
		renewed_by_item_id: null,
		auto_renew: false,
		currency: 'CLP',
		price_id: null,
	},
	{
		id: SOPORTE,
		product_id: PRODUCT_SOPORTE,
		product_name: 'Soporte',
		account: null,
		item_type: 'Recurrente',
		categoria: 'NEW',
		unit_of_measure: 'UND',
		quantity: '1',
		unit_price: '200',
		price_entry_mode: 'monthly',
		annual_unit_price: '2400',
		discount_type: null,
		discount_value: '0',
		monthly_price: '200',
		billing_period_price: '200',
		price: '2400',
		final_price: '2400',
		term_months: 12,
		billing_frequency: 'Mensual',
		billing_method: 'Anticipado',
		is_recurring: true,
		start_date: '2026-01-01',
		end_date: '2026-12-31',
		booking_date: '2026-01-01',
		churn_date: null,
		related_item_id: null,
		renews_item_id: null,
		renewed_by_item_id: null,
		auto_renew: false,
		currency: 'CLP',
		price_id: null,
	},
];
const invoiceDbRow = (mm: string): Row => ({
	id: `inv-${mm}`,
	invoice_number: Number(mm) <= 9 ? `F-${mm}` : null,
	status: Number(mm) <= 9 ? 'Emitida' : 'Por Emitir',
	is_active: true,
	is_legacy: false,
	invoice_type: 'Automatica',
	document_type: 'FACTURA',
	export_type: 0,
	issue_date: `2026-${mm}-01`,
	due_date: `2026-${mm}-28`,
	client_entity_id: 'entity-1',
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	fx_contract_to_invoice: '1',
	tax_rate: '19',
	amount_contract_currency: '1200',
	vat: '228',
	amount_invoice_currency: '1200',
	total_invoice_currency: '1428',
});
const lineDbRows = (mm: string): Row[] => {
	const last = new Date(Date.UTC(2026, Number(mm), 0)).getUTCDate();

	return [
		[LICENCIA, 'lic', 10, 100, 1000, 190, 1190, PRODUCT_LICENCIA],
		[SOPORTE, 'sop', 1, 200, 200, 38, 238, PRODUCT_SOPORTE],
	].map(([itemId, suffix, quantity, unit, subtotal, tax, total, productId]) => ({
		id: `line-${mm}-${suffix}`,
		invoice_id: `inv-${mm}`,
		contract_item_id: itemId,
		product_id: productId,
		description: `Periodo ${mm}`,
		quantity,
		unit_of_measure: 'UND',
		unit_price_contract_currency: unit,
		unit_price_invoice_currency: unit,
		discount_pct: 0,
		subtotal_contract_currency: subtotal,
		subtotal_invoice_currency: subtotal,
		tax_amount_contract_currency: tax,
		tax_amount_invoice_currency: tax,
		total_contract_currency: total,
		total_invoice_currency: total,
		billing_period_start: `2026-${mm}-01`,
		billing_period_end: `2026-${mm}-${String(last).padStart(2, '0')}`,
	}));
};
const MONTHS = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];

const build = (handler: Handler = () => undefined) => {
	let inserted = 0;
	const route = async (sql: string, params: unknown[] = []) => {
		const custom = handler(sql, params);

		if (custom !== undefined) return custom;
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('get_cutoff_date')) return [contractDbRow];
		if (sql.includes('FROM contract_items ci') && sql.includes('LEFT JOIN prices')) return itemDbRows;
		if (sql.includes('FROM invoices i') && sql.includes('ORDER BY i.issue_date')) return MONTHS.map(invoiceDbRow);
		if (sql.includes('FROM invoice_items ii') && sql.includes('JOIN invoices i')) return MONTHS.flatMap(lineDbRows);
		if (sql.includes('FROM quantities q')) return [];
		if (sql.includes('FROM churn_reasons')) return params[0] === 'reason-1' ? [{ id: 'reason-1', name: 'Presupuesto' }] : [];
		if (sql.includes("metadata->>'idempotency_key'")) return [];
		if (sql.includes('INSERT INTO contract_items')) return [{ id: `item-new-${++inserted}` }];
		if (sql.includes('INSERT INTO invoices')) return [{ id: `inv-new-${++inserted}` }];
		if (sql.includes('INSERT INTO invoice_items')) return [{ id: `line-new-${++inserted}` }];
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: 'event-1' }];
		if (sql.includes('SELECT COUNT(*) AS lines')) return [{ lines: '1', subtotal: '200', tax: '38' }];
		if (sql.includes('FROM quote_stages')) return [{ id: 'stage-1' }];
		if (sql.includes('FROM products'))
			return [
				{ id: PRODUCT_LICENCIA, name: 'Licencia' },
				{ id: PRODUCT_SOPORTE, name: 'Soporte' },
			];
		if (sql.includes('FROM invoices WHERE id = $1 AND holding_id = $2'))
			return [{ ...invoiceDbRow('09'), fx_contract_to_system: '1', invoice_series: 'FAC' }];

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
	const contracts = {
		resolveContract: jest.fn().mockResolvedValue({ id: CONTRACT_ID, status: 'Activo' }),
		detail: jest.fn().mockResolvedValue({ id: CONTRACT_ID, contract_number: 'CTR-2026-001' }),
	} as unknown as ContractsService;

	const invoicesService = new ContractInvoicesService(dataSource, contracts, {} as never);
	const invoiceEdit = new ContractInvoiceEditService(dataSource, contracts, invoicesService);
	const descriptions = new ContractInvoiceDescriptionsService(dataSource, contracts, invoicesService);

	return { service: new ContractChangesService(dataSource, contracts, invoiceEdit, descriptions), runner, dataSource, contracts, descriptions };
};
const sqlOf = (mock: jest.Mock) => mock.mock.calls.map(([sql]) => sql as string);
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const firstIndex = (list: string[], needle: string) => list.findIndex((sql) => sql.includes(needle));
const request = (change: ContractChangeRequestDto['change'], overrides: Partial<ContractChangeRequestDto> = {}): ContractChangeRequestDto => ({
	effective_date: '2026-11-15',
	origin: { type: 'manual' },
	reason_id: 'reason-1',
	reason: 'Pedido del cliente',
	change,
	...overrides,
});
const today = new Date('2026-09-28T12:00:00Z');

describe('ContractChangesService.apply (POST /contracts/:id/changes)', () => {
	it('item_remove: una transacción con la costura, el lock, el orden ítems → facturas → contrato → RSM → evento, y nunca toca emitidas', async () => {
		const { service, runner, contracts } = build();
		const result = await service.apply(
			CONTRACT_ID,
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }),
			HOLDING,
			'auth-1',
			'key-1',
			today
		);
		const sql = sqlOf(runner.query);

		expect(runner.startTransaction).toHaveBeenCalled();
		expect(runner.commitTransaction).toHaveBeenCalled();
		expect(runner.rollbackTransaction).not.toHaveBeenCalled();
		expect(sql[0]).toContain(`set_config('sapira.writer', 'api', true)`);
		expect(sql[1]).toContain('FOR UPDATE');
		// Orden del §4: ítems (espejo + churn_date) → facturas (prorrateo y línea quitada, encabezados) → contrato → RSM → evento.
		const order = [
			firstIndex(sql, 'INSERT INTO contract_items'),
			firstIndex(sql, 'UPDATE contract_items SET churn_date'),
			firstIndex(sql, 'DELETE FROM invoice_items'),
			firstIndex(sql, 'UPDATE invoice_items SET quantity'),
			firstIndex(sql, 'SELECT COUNT(*) AS lines'),
			firstIndex(sql, 'UPDATE contracts SET'),
			firstIndex(sql, 'revenue_schedule_rebuild'),
			firstIndex(sql, 'INSERT INTO contract_lifecycle_events'),
		];

		expect(order.every((index) => index > 1)).toBe(true);
		expect([...order].sort((a, b) => a - b)).toEqual(order);
		// Costura: el espejo se inserta con categoría, fin y precios derivados explícitos en el mismo INSERT (sin UPDATE del fin).
		const [itemInsert] = calls(runner.query, 'INSERT INTO contract_items');

		expect(itemInsert[1].slice(2, 8)).toEqual([PRODUCT_LICENCIA, 'Licencia', null, 'Recurrente', 'Usuarios', 'DOWNSELL']);
		expect(itemInsert[1][20]).toBe('2026-12-31');
		expect(itemInsert[0]).toContain('annual_price, monthly_price, billing_period_price');
		// DOWNSELL: mensual = final ÷ plazo (-2.000 / 2), período mensual; anual = unitario × 12 × cantidad (rama del trigger).
		expect(itemInsert[1].slice(29, 32)).toEqual([-12000, -1000, -1000]);
		// §9.3.9: el espejo sigue el ciclo del contrato (billing_anchor_day NULL).
		expect(itemInsert[1][32]).toBeNull();
		expect(calls(runner.query, 'UPDATE contract_items SET end_date')).toHaveLength(0);
		// `contracts.term` lo escribe la API (antes `update_contract_term`).
		expect(calls(runner.query, 'UPDATE contracts c SET term')[0][1]).toEqual([CONTRACT_ID, HOLDING]);
		expect(calls(runner.query, 'UPDATE contract_items SET churn_date')[0][1]).toEqual([LICENCIA, HOLDING, '2026-11-15', 1000]);
		// Facturas: solo la línea del ítem (noviembre prorrateada, diciembre quitada); las emitidas no reciben ningún UPDATE/DELETE.
		expect(calls(runner.query, 'UPDATE invoice_items SET quantity')[0][1].slice(0, 2)).toEqual(['line-11-lic', 'inv-11']);
		expect(calls(runner.query, 'DELETE FROM invoice_items')[0][1]).toEqual(['line-12-lic', 'inv-12', HOLDING]);
		const touchedInvoices = runner.query.mock.calls
			.filter(([query]) => /UPDATE invoice_items|DELETE FROM invoice_items|UPDATE invoices SET/.test(query as string))
			.flatMap(([, params]) => (params as unknown[]).filter((value) => typeof value === 'string' && /^(inv|line)-/.test(value)));

		expect(touchedInvoices.every((id) => !/-(0\d)/.test(String(id)))).toBe(true);
		expect(calls(runner.query, 'UPDATE invoices SET amount_contract_currency')).toHaveLength(2);
		expect(calls(runner.query, 'INSERT INTO invoices')).toHaveLength(0);
		expect(calls(runner.query, 'UPDATE contracts SET')[0][1]).toEqual([CONTRACT_ID, HOLDING, 12400]);
		expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT_ID, '2026-11-01']);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(event[1].slice(2, 4)).toEqual(['DOWNSELL', 'early']);
		expect(event[1][6]).toBe('user-1');
		expect(event[1][7]).toBe('2026-11-15');
		expect(event[1][8]).toBe(-1000);
		expect(JSON.parse(event[1][9] as string)).toEqual([LICENCIA, 'item-new-1']);
		expect(JSON.parse(event[1][10] as string)).toMatchObject({
			source: 'api_v2',
			change_type: 'item_remove',
			idempotency_key: 'key-1',
			reason_id: 'reason-1',
			created_items: { 'new:1': 'item-new-1' },
			before: { mrr: 1200 },
			after: { mrr: 200 },
		});
		expect(result).toMatchObject({
			applied: true,
			idempotent: false,
			event_id: 'event-1',
			created: { items: { 'new:1': 'item-new-1' }, invoices: [], credit_notes: [] },
		});
		expect(result.detail).toEqual({ id: CONTRACT_ID, contract_number: 'CTR-2026-001' });
		expect(contracts.detail).toHaveBeenCalledWith(CONTRACT_ID, HOLDING);
	});

	it('emitida en el rango → NC espejo con el estado de la emitida (nunca Por Emitir), referencia a la original, montos negativos y la línea con su ítem; la emitida no se modifica', async () => {
		const { service, runner } = build();

		await service.apply(
			CONTRACT_ID,
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }, { effective_date: '2026-09-15' }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const [nc] = calls(runner.query, `'NC', $17`);

		// Decisión 01-10: la NC nace siempre Emitida, sin vencimiento ni vínculo con el ERP.
		expect(nc[1][6]).toBe('Emitida');
		expect(nc[0]).toContain('$6, $6, $6, NULL');
		expect(nc[0]).not.toContain('odoo_invoice_id');
		expect(nc[1][30]).toBe('Automatica');
		const [reference] = calls(runner.query, 'INSERT INTO invoice_references');

		// Referencia a la emitida (folio y tipo del original, código 3 = corrige montos).
		expect((reference[1] as unknown[]).slice(2, 6)).toEqual(['F-09', '33', 'Factura electrónica', '3']);
		// 1.000 × 16/30 = 533,33 neto, IVA 101,33; espejo de inv-09 con su moneda y FX.
		expect(nc[1].slice(10, 14)).toEqual([-533.33, -533.33, -101.33, -634.66]);
		expect(nc[1][16]).toBe('inv-09');
		const [ncLine] = runner.query.mock.calls.filter(
			([sql, params]) => (sql as string).includes('INSERT INTO invoice_items') && String((params as unknown[])[4]).includes('NC espejo')
		);

		expect(ncLine[1].slice(10, 12)).toEqual([-533.33, -533.33]);
		// Costura: la línea de la NC nace con su ítem (sin patrón B); el grupo es el de la emitida y las condiciones las del contrato.
		expect(ncLine[0]).toContain('contract_item_id, holding_id, invoice_id');
		// $25 = contract_item_id ($26 = fecha de la tasa de la línea original, multimoneda).
		expect((ncLine[1] as unknown[])[24]).toBe(LICENCIA);
		expect(calls(runner.query, 'SET contract_item_id = x.contract_item_id')).toHaveLength(0);
		expect(nc[0]).toContain('(SELECT COALESCE(r.invoice_group_id, r.id) FROM invoices r WHERE r.id = $17::uuid)');
		expect(nc[0]).toContain('(SELECT k.invoice_terms_and_conditions FROM contracts k WHERE k.id = $2::uuid)');
		expect(calls(runner.query, 'UPDATE invoices SET').filter(([, params]) => (params as unknown[]).includes('inv-09'))).toHaveLength(0);
	});

	it('renewal: inserta el RENEWAL, marca renewed_by con el id real, crea las facturas nuevas con el ítem en cada línea y mueve el fin con el bypass explícito', async () => {
		const { service, runner } = build();
		const result = await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'renewal', items: [{ item_id: LICENCIA }, { item_id: SOPORTE }] },
				{ effective_date: '2026-12-15', reason_id: undefined, reason: undefined }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);

		expect(calls(runner.query, 'UPDATE contract_items SET renewed_by_item_id')[0][1]).toEqual([LICENCIA, HOLDING, 'item-new-1']);
		expect(calls(runner.query, 'INSERT INTO invoices')).toHaveLength(12);
		expect(calls(runner.query, 'INSERT INTO invoice_items')).toHaveLength(24);
		// Costura: sin patrón B, cada línea lleva su ítem en el INSERT.
		expect(calls(runner.query, 'SET contract_item_id = x.contract_item_id')).toHaveLength(0);
		expect(calls(runner.query, 'INSERT INTO invoice_items').every(([query]) => (query as string).includes('invoice_id, contract_item_id,'))).toBe(
			true
		);
		const sql = sqlOf(runner.query);

		expect(firstIndex(sql, `set_config('sapira.bypass_end_date_guard', 'on', true)`)).toBeLessThan(firstIndex(sql, 'UPDATE contracts SET'));
		expect(calls(runner.query, 'UPDATE contracts SET')[0][1]).toEqual([CONTRACT_ID, HOLDING, 14400 * 2, '2027-12-31']);
		expect(result.created.invoices).toHaveLength(12);
		expect(result.event_id).toBe('event-1');
	});

	it('item_add con origen cotización: las líneas nuevas se suman a la PE del mes con su FX y la cotización pasa a "Contrato creado" al final', async () => {
		const { service, runner } = build((sql) => {
			if (sql.includes('FROM products')) return [{ id: PRODUCT_SOPORTE.replace('b', 'c'), name: 'Analítica' }];
			if (sql.includes('FROM quotes q')) return [{ id: 'q-1', quote_type: 'Upselling', already_applied: false }];

			return undefined;
		});
		const product = PRODUCT_SOPORTE.replace('b', 'c');

		await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'item_add', items: [{ product_id: product, quantity: 2, unit_price: 300 }] },
				{ origin: { type: 'quote', quote_id: 'q-1' }, reason: 'ok' }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		// Sin encabezado nuevo: dos líneas (tramo + diciembre) dentro de inv-12 y su encabezado recalculado.
		expect(calls(runner.query, 'INSERT INTO invoices')).toHaveLength(0);
		const lines = calls(runner.query, 'INSERT INTO invoice_items');

		expect(lines).toHaveLength(2);
		expect(lines.map(([, params]) => (params as unknown[])[0])).toEqual(['inv-12', 'inv-12']);
		expect(lines.map(([, params]) => (params as unknown[])[7])).toEqual([320, 600]);
		// El ítem nuevo (id real) va en el mismo INSERT de cada línea; inv-12 se recalcula y se valoriza a moneda del sistema.
		expect(lines.map(([, params]) => (params as unknown[]).at(-1))).toEqual(['item-new-1', 'item-new-1']);
		expect(calls(runner.query, 'SET contract_item_id = x.contract_item_id')).toHaveLength(0);
		expect(calls(runner.query, 'COALESCE(hs.system_currency')[0][1]).toEqual([['inv-12'], HOLDING]);
		const sql = sqlOf(runner.query);

		expect(firstIndex(sql, 'UPDATE quotes SET quote_stage_id')).toBeGreaterThan(firstIndex(sql, 'INSERT INTO contract_lifecycle_events'));
		expect(calls(runner.query, 'UPDATE quotes SET quote_stage_id')[0][1]).toEqual(['q-1', HOLDING, 'stage-1']);
		// Historial de la cotización: APPLIED_TO_CONTRACT con el contrato y el evento del cambio, después de mover la etapa.
		expect(firstIndex(sql, 'INSERT INTO quote_events')).toBeGreaterThan(firstIndex(sql, 'UPDATE quotes SET quote_stage_id'));
		const [quoteEvent] = calls(runner.query, 'INSERT INTO quote_events');

		expect(quoteEvent[0]).toContain("'APPLIED_TO_CONTRACT'");
		const params = quoteEvent[1] as unknown[];

		expect(params.slice(0, 2)).toEqual([HOLDING, 'q-1']);
		expect(params[3]).toBe('stage-1');
		expect(params[5]).toBe('contract_created');
		expect(params[6]).toBe('user-1');
		expect(JSON.parse(params[7] as string)).toMatchObject({
			contract_id: CONTRACT_ID,
			change_event_id: 'event-1',
			change_type: 'item_add',
			stage_updated: true,
		});
	});

	it('origen cotización sin etapa "Contrato creado": la cotización queda en su etapa pero el evento APPLIED_TO_CONTRACT se registra igual', async () => {
		const { service, runner } = build((sql) => {
			if (sql.includes('FROM products')) return [{ id: PRODUCT_SOPORTE.replace('b', 'c'), name: 'Analítica' }];
			if (sql.includes('FROM quotes q'))
				return [{ id: 'q-1', quote_type: 'Upselling', already_applied: false, quote_stage_id: 'stage-sent', kind: 'sent' }];
			if (sql.includes('FROM quote_stages')) return [];

			return undefined;
		});

		await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_SOPORTE.replace('b', 'c'), quantity: 2, unit_price: 300 }] },
				{ origin: { type: 'quote', quote_id: 'q-1' }, reason: 'ok' }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		expect(calls(runner.query, 'UPDATE quotes SET quote_stage_id')).toHaveLength(0);
		const params = calls(runner.query, 'INSERT INTO quote_events')[0][1] as unknown[];

		expect(params.slice(2, 6)).toEqual(['stage-sent', 'stage-sent', 'sent', 'sent']);
		expect(JSON.parse(params[7] as string)).toMatchObject({ stage_updated: false });
	});

	it('item_add con `price`: inserta la fila de prices (owner contract, v1) después del ítem y lo apunta con price_id', async () => {
		const { service, runner } = build((sql) => (sql.includes('INSERT INTO prices') ? [{ id: 'price-1' }] : undefined));
		const price = {
			model: 'graduated',
			quantity_type: 'fixed',
			tiers: [
				{ from: 1, to: 100, per_unit_amount: 2 },
				{ from: 101, to: null, per_unit_amount: 1 },
			],
		};

		await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_LICENCIA, quantity: 150, price, account: 'Sur' }] },
				{ effective_date: '2026-12-01', reason: 'ok' }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const sql = sqlOf(runner.query);
		const [priceInsert] = calls(runner.query, 'INSERT INTO prices');

		expect(firstIndex(sql, 'INSERT INTO contract_items')).toBeLessThan(firstIndex(sql, 'INSERT INTO prices'));
		expect(priceInsert[1].slice(0, 8)).toEqual([HOLDING, PRODUCT_LICENCIA, CONTRACT_ID, 'Licencia', 'CLP', 'graduated', 'fixed', null]);
		expect(JSON.parse(priceInsert[1][9] as string)).toHaveLength(2);
		expect(priceInsert[1][16]).toBe('user-1');
		expect(calls(runner.query, 'UPDATE contract_items SET price_id')[0][1]).toEqual(['item-new-1', HOLDING, 'price-1']);
		// La línea nueva va tarifada por el motor (250) con su desglose.
		const line = calls(runner.query, 'INSERT INTO invoice_items')[0][1] as unknown[];

		expect(line[7]).toBe(250);
		expect(JSON.parse(line[24] as string)).toHaveLength(2);
	});

	it('price_model_change: precio v+1 que reemplaza al anterior, base del RENEWAL, consumos al ítem nuevo y la Por Emitir vaciada no se cancela', async () => {
		const { service, runner } = build((sql) => (sql.includes('INSERT INTO prices') ? [{ id: 'price-2' }] : undefined));
		const price = {
			model: 'graduated',
			quantity_type: 'fixed',
			tiers: [
				{ from: 1, to: 5, per_unit_amount: 100 },
				{ from: 6, to: null, per_unit_amount: 80 },
			],
		};

		await service.apply(
			CONTRACT_ID,
			request({ type: 'price_model_change', items: [{ item_id: LICENCIA, price }] } as never, { effective_date: '2026-11-01', reason: 'ok' }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const sql = sqlOf(runner.query);
		const [priceInsert] = calls(runner.query, 'INSERT INTO prices');

		expect(priceInsert[1].slice(5, 7)).toEqual(['graduated', 'fixed']);
		expect(priceInsert[1].slice(20)).toEqual([1, null]);
		expect(calls(runner.query, 'SET renewal_base_unit_price')[0][1]).toEqual(['item-new-1', HOLDING, 100]);
		// La Por Emitir que recibe las filas nuevas no pasa por la cancelación de "sin líneas" antes de recibirlas.
		expect(sql.some((text) => text.includes(`SET status = 'Cancelada'`))).toBe(false);
		expect(firstIndex(sql, 'DELETE FROM invoice_items')).toBeLessThan(firstIndex(sql, 'INSERT INTO invoice_items'));
	});

	it('item_add con `price_id`: lee el catálogo del holding y la fila de prices es una copia (nombre del catálogo, list_price_id)', async () => {
		const CATALOG = 'ca000000-0000-4000-8000-000000000001';
		const { service, runner } = build((sql) => {
			if (sql.includes('INSERT INTO prices')) return [{ id: 'price-1' }];
			if (sql.includes('FROM prices WHERE id = ANY')) {
				return [
					{
						id: CATALOG,
						name: 'Licencia por tramos',
						product_id: PRODUCT_LICENCIA,
						currency: 'CLP',
						status: 'active',
						version: 2,
						model: 'graduated',
						quantity_type: 'fixed',
						tiers: [
							{ from: 1, to: 100, per_unit_amount: 2 },
							{ from: 101, to: null, per_unit_amount: 1 },
						],
					},
				];
			}

			return undefined;
		});

		await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'item_add', items: [{ product_id: PRODUCT_LICENCIA, quantity: 150, price_id: CATALOG }] },
				{ effective_date: '2026-12-01', reason: 'ok' }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const [load] = calls(runner.query, 'FROM prices WHERE id = ANY');

		expect(load[0]).toContain(`owner = 'catalog'`);
		expect(load[1]).toEqual([[CATALOG], HOLDING]);
		const [priceInsert] = calls(runner.query, 'INSERT INTO prices');
		const params = priceInsert[1] as unknown[];

		expect(priceInsert[0]).toContain(`'contract'`);
		expect(params.slice(0, 7)).toEqual([HOLDING, PRODUCT_LICENCIA, CONTRACT_ID, 'Licencia por tramos', 'CLP', 'graduated', 'fixed']);
		// list_price_id ($20); detrás van la versión y el precio que reemplaza (price_model_change).
		expect(params[19]).toBe(CATALOG);
		expect(params.slice(20)).toEqual([1, null]);
		expect(calls(runner.query, 'UPDATE contract_items SET price_id')[0][1]).toEqual(['item-new-1', HOLDING, 'price-1']);
		expect((calls(runner.query, 'INSERT INTO invoice_items')[0][1] as unknown[])[7]).toBe(250);
	});

	it('bloqueos → 409 `blocked` con el preview y rollback, sin escribir', async () => {
		const { service, runner } = build((sql) => (sql.includes('get_cutoff_date') ? [{ ...contractDbRow, cutoff_date: '2026-11-30' }] : undefined));
		const error = await service
			.apply(CONTRACT_ID, request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }), HOLDING, 'auth-1', undefined, today)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ConflictException);
		const body = (error as ConflictException).getResponse() as { code: string; preview: { blockers: Array<{ code: string }> } };

		expect(body.code).toBe('blocked');
		expect(body.preview.blockers.map((blocker) => blocker.code)).toEqual(['period_closed']);
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(runner.commitTransaction).not.toHaveBeenCalled();
		expect(sqlOf(runner.query).some((sql) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
	});

	it('advertencias sin motivo → 400 `reason`; con motivo se aplica', async () => {
		const { service, runner } = build();
		const change = { type: 'item_add' as const, items: [{ product_id: PRODUCT_LICENCIA, quantity: 1, unit_price: 100 }] };
		const error = await service
			.apply(CONTRACT_ID, request(change, { reason: undefined, reason_id: undefined }), HOLDING, 'auth-1', undefined, today)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(BadRequestException);
		expect((error as BadRequestException).getResponse()).toMatchObject({
			errors: [{ field: 'reason', message: expect.stringContaining('upsell_of_existing_product') }],
		});
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		const ok = build();

		await expect(
			ok.service.apply(CONTRACT_ID, request(change, { reason: 'Otra cuenta' }), HOLDING, 'auth-1', undefined, today)
		).resolves.toMatchObject({ applied: true });
	});

	it('Idempotency-Key ya registrada: no escribe, devuelve idempotent con el evento previo', async () => {
		const { service, runner } = build((sql) => (sql.includes("metadata->>'idempotency_key'") ? [{ id: 'event-old' }] : undefined));
		const result = await service.apply(
			CONTRACT_ID,
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }),
			HOLDING,
			'auth-1',
			'key-1',
			today
		);

		expect(result).toMatchObject({ applied: true, idempotent: true, event_id: 'event-old' });
		expect(runner.rollbackTransaction).toHaveBeenCalledTimes(1);
		expect(sqlOf(runner.query).some((sql) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
	});

	it('Idempotency-Key: el evento guarda el preview y la huella del cuerpo; el reintento devuelve ese preview y otro cuerpo → 409', async () => {
		const first = build();
		const body = request({ type: 'item_remove', items: [{ item_id: LICENCIA }] });
		const applied = await first.service.apply(CONTRACT_ID, body, HOLDING, 'auth-1', 'key-1', today);
		const metadata = JSON.parse(calls(first.runner.query, 'INSERT INTO contract_lifecycle_events')[0][1][10] as string);

		expect(metadata.request_hash).toBe(requestHash(body));
		expect(metadata.preview).toMatchObject({ type: 'item_remove', effective_date: '2026-11-15' });
		const replay = build((sql) => (sql.includes("metadata->>'idempotency_key'") ? [{ id: 'event-old', metadata }] : undefined));
		const result = await replay.service.apply(CONTRACT_ID, { ...body }, HOLDING, 'auth-1', 'key-1', today);

		expect(result).toMatchObject({ applied: true, idempotent: true, event_id: 'event-old', created: applied.created });
		// El preview es el guardado al aplicar (no se re-planifica sobre el contrato ya cambiado).
		expect(result.invoices).toEqual(JSON.parse(JSON.stringify(applied.invoices)));
		expect(result.warnings.map((warning) => warning.code)).toContain('idempotent');
		expect(sqlOf(replay.runner.query).some((sql) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
		const conflict = build((sql) => (sql.includes("metadata->>'idempotency_key'") ? [{ id: 'event-old', metadata }] : undefined));
		const error = await conflict.service
			.apply(CONTRACT_ID, request({ type: 'item_remove', items: [{ item_id: SOPORTE }] }), HOLDING, 'auth-1', 'key-1', today)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ConflictException);
		expect((error as ConflictException).getResponse()).toMatchObject({ code: 'idempotency_conflict', event_id: 'event-old' });
	});

	it('loadContext lee anulada, borrador en el ERP, receptor, vínculo de OC, origen de la tasa, NC previas y consumos', async () => {
		const { service, dataSource } = build((sql) => {
			if (sql.includes('FROM invoices i') && sql.includes('ORDER BY i.issue_date'))
				return MONTHS.map((mm) =>
					mm === '09'
						? { ...invoiceDbRow(mm), voided: true }
						: mm === '11'
							? {
									...invoiceDbRow(mm),
									odoo_invoice_id: '55',
									sent_to_odoo_at: new Date('2026-09-20T00:00:00Z'),
									client_tax_id: '77.777.777-7',
								}
							: invoiceDbRow(mm)
				);
			if (sql.includes('FROM invoice_items ii') && sql.includes('JOIN invoices i'))
				return MONTHS.flatMap(lineDbRows).map((row) =>
					row.id === 'line-12-sop' ? { ...row, visible_line_id: 'line-12-lic', fx_rate_source: 'net_exact' } : row
				);
			if (sql.includes("nc.credit_type = 'discount'"))
				return [
					{
						related_invoice_id: 'inv-08',
						contract_item_id: LICENCIA,
						billing_period_start: '2026-08-01',
						billing_period_end: '2026-08-31',
						subtotal_contract_currency: '-150',
					},
				];
			if (sql.includes('FROM consumption_entries e'))
				return [
					{
						contract_item_id: LICENCIA,
						period_start: '2026-12-01',
						quantity: '7',
						amount_override: null,
						apply_item_discount: true,
						is_estimated: false,
					},
				];

			return undefined;
		});
		const ctx = await service.loadContext(
			dataSource,
			CONTRACT_ID,
			HOLDING,
			request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }),
			'2026-09-28'
		);
		const invoice = (id: string) => ctx.invoices.find((row) => row.id === id)!;

		expect(invoice('inv-09').voided).toBe(true);
		expect(invoice('inv-11')).toMatchObject({ odoo_invoice_id: 55, sent_to_odoo_at: '2026-09-20T00:00:00.000Z', client_tax_id: '77.777.777-7' });
		expect(invoice('inv-12').lines.find((line) => line.id === 'line-12-sop')).toMatchObject({
			visible_line_id: 'line-12-lic',
			fx_rate_source: 'net_exact',
		});
		expect(invoice('inv-08').lines.find((line) => line.contract_item_id === LICENCIA)!.previously_credited).toBe(150);
		expect(invoice('inv-12').lines.find((line) => line.contract_item_id === LICENCIA)!.consumption).toEqual({
			quantity: 7,
			amount_override: null,
			apply_item_discount: true,
			is_estimated: false,
		});
	});

	it('contract_cancel: refresca el total en moneda del sistema aunque el contrato quede Cancelado', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('UPDATE contracts SET') && sql.includes('RETURNING')
				? [{ status: 'Cancelado', total_value: '13200', contract_currency: 'CLP', booking_date: '2026-01-01' }]
				: sql.includes('SELECT status, total_value, contract_currency')
					? [{ status: 'Activo', total_value: '14400', contract_currency: 'CLP', booking_date: '2026-01-01' }]
					: sql.includes('fx_system_policy')
						? [{ contract_currency: 'CLP', fx_date: '2026-01-01', system_currency: 'CLP', fx_policy: 'monthly_avg' }]
						: undefined
		);

		await service.apply(
			CONTRACT_ID,
			request({ type: 'contract_cancel', invoice_decisions: [{ invoice_id: 'inv-12', action: 'cancel' }] }, { effective_date: '2026-12-01' }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		expect(calls(runner.query, 'total_value_system_currency').length).toBeGreaterThan(0);
	});

	it('update_invoices_fx en spot: origen y fecha de la tasa en NULL; nunca reescribe la cantidad de la línea', async () => {
		const { service, runner } = build();

		await service.apply(
			CONTRACT_ID,
			request({ type: 'billing_conditions', invoice_currency: 'USD', fx_invoice_policy: 'spot' }, { effective_date: '2026-12-01' }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const [fx] = calls(runner.query, 'UPDATE invoice_items SET invoice_currency');

		expect(fx[0]).toContain('fx_rate_source = CASE WHEN $4::numeric IS NULL THEN NULL ELSE $5 END');
		expect(fx[0]).toContain('fx_rate_date = CASE WHEN $4::numeric IS NULL THEN NULL ELSE CURRENT_DATE END');
		expect(fx[0]).not.toMatch(/\bquantity\s*=/);
		expect(fx[1]).toEqual(['inv-12', HOLDING, 'USD', null, 'contract-change']);
	});

	it('update_line de una línea con consumo escribe el desglose del motor y conserva el origen de la cantidad', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('FROM consumption_entries e')
				? [
						{
							contract_item_id: LICENCIA,
							period_start: '2026-12-01',
							quantity: '7',
							amount_override: null,
							apply_item_discount: true,
							is_estimated: true,
						},
					]
				: undefined
		);

		await service.apply(
			CONTRACT_ID,
			request({ type: 'item_change', items: [{ item_id: LICENCIA, quantity: 10, unit_price: 120 }] }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const update = calls(runner.query, 'UPDATE invoice_items SET quantity').find(([, params]) => (params as unknown[])[0] === 'line-12-lic')!;

		expect(update[0]).toContain('pricing_breakdown = COALESCE($16::jsonb, pricing_breakdown)');
		expect((update[1] as unknown[])[2]).toBe(7);
		expect(JSON.parse((update[1] as unknown[])[15] as string)).toEqual([expect.objectContaining({ quantity: 7, amount: 840 })]);
		expect((update[1] as unknown[])[16]).toBe('estimated');
	});

	it('tipos diferidos → 400 antes de abrir la transacción', async () => {
		const { service, dataSource } = build();

		await expect(service.apply(CONTRACT_ID, request({ type: 'price_adjustment' }), HOLDING, 'auth-1', undefined, today)).rejects.toBeInstanceOf(
			BadRequestException
		);
		expect((dataSource as unknown as { createQueryRunner: jest.Mock }).createQueryRunner).not.toHaveBeenCalled();
	});

	it('billing_conditions: escribe el contrato y reasigna las PE desde la fecha efectiva; sin ítems, sin RSM', async () => {
		const { service, runner } = build();

		await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'billing_conditions', auto_send_to_odoo: true, auto_invoice: true },
				{ effective_date: '2026-12-01', reason_id: undefined, reason: undefined }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		expect(calls(runner.query, 'UPDATE invoices SET auto_invoice')[0][1]).toEqual([['inv-12'], HOLDING, true]);
		expect(calls(runner.query, 'UPDATE contracts SET')[0][1]).toEqual([CONTRACT_ID, HOLDING, true, true]);
		expect(calls(runner.query, 'revenue_schedule_rebuild')).toHaveLength(0);
		expect(calls(runner.query, 'INSERT INTO contract_items')).toHaveLength(0);
		expect(calls(runner.query, 'INSERT INTO contract_lifecycle_events')[0][1][2]).toBe('CONDITIONS_UPDATED');
	});
});

/** Por Emitir activas (consulta del masivo): una aplicable, una en borrador del ERP, una legacy, una anterior a la fecha efectiva. */
const PENDING_TERMS_ROWS: Row[] = [
	{ ...invoiceDbRow('10') },
	{ ...invoiceDbRow('11') },
	{ ...invoiceDbRow('12'), odoo_invoice_id: 77, sent_to_odoo_at: '2026-09-20T10:00:00Z' },
	{ ...invoiceDbRow('12'), id: 'inv-legacy', is_legacy: true, issue_date: '2026-12-15' },
];
const pendingTermsHandler: Handler = (sql) => (sql.includes("i.status = 'Por Emitir' AND i.is_active = true") ? PENDING_TERMS_ROWS : undefined);
const termsRequest = (applyToPending: boolean) =>
	request(
		{ type: 'billing_conditions', invoice_terms_and_conditions: 'Pago a 30 días', apply_to_pending: applyToPending },
		{ effective_date: '2026-11-01' }
	);

describe('billing_conditions con apply_to_pending (términos a las Por Emitir)', () => {
	it('preview sin apply_to_pending: conserva el aviso pending_invoices_keep_old_terms y no lee las Por Emitir', async () => {
		const { service, dataSource } = build(pendingTermsHandler);
		const preview = await service.preview(CONTRACT_ID, termsRequest(false), HOLDING, today);

		expect(preview.warnings.map((warning) => warning.code)).toEqual(['pending_invoices_keep_old_terms']);
		expect(preview.pending_terms).toBeUndefined();
		expect(calls((dataSource as unknown as { query: jest.Mock }).query, "i.status = 'Por Emitir' AND i.is_active = true")).toHaveLength(0);
	});

	it('preview con apply_to_pending: pending_invoices_updated + omitidas con motivo (ERP borrador, legacy); nada antes de la fecha efectiva', async () => {
		const { service, runner } = build(pendingTermsHandler);
		const preview = await service.preview(CONTRACT_ID, termsRequest(true), HOLDING, today);

		expect(preview.pending_terms).toEqual({
			updated: ['inv-11'],
			skipped: [
				{ invoice_id: 'inv-12', invoice_number: null, reason: 'sent_to_erp_draft', message: expect.any(String) },
				{ invoice_id: 'inv-legacy', invoice_number: null, reason: 'legacy_invoice', message: expect.any(String) },
			],
		});
		expect(preview.warnings).toEqual([
			{ code: 'pending_invoices_updated', message: '1 factura por emitir tomará los términos nuevos' },
			{ code: 'pending_invoices_skipped', message: expect.stringContaining('2 factura(s) por emitir conservan sus términos') },
		]);
		expect(runner.query).not.toHaveBeenCalled();
	});

	it('aplicar: contrato primero, luego solo el texto en las aplicables (con lock) y un INVOICE_EDITED por factura con bulk_id común', async () => {
		const { service, runner } = build(pendingTermsHandler);
		const result = await service.apply(CONTRACT_ID, termsRequest(true), HOLDING, 'auth-1', undefined, today);
		const sql = sqlOf(runner.query);

		expect(sql[0]).toContain('sapira.writer');
		expect(calls(runner.query, "i.status = 'Por Emitir' AND i.is_active = true")[0][0]).toContain('FOR UPDATE OF i');
		expect(firstIndex(sql, 'UPDATE contracts SET')).toBeLessThan(firstIndex(sql, 'UPDATE invoices SET invoice_terms_and_conditions'));
		expect(calls(runner.query, 'UPDATE invoices SET invoice_terms_and_conditions')).toHaveLength(1);
		expect(calls(runner.query, 'UPDATE invoices SET invoice_terms_and_conditions')[0][1]).toEqual([['inv-11'], HOLDING, 'Pago a 30 días']);
		expect(sql.some((statement) => /updated_at/.test(statement) && /UPDATE invoices/.test(statement))).toBe(false);
		const events = calls(runner.query, 'INSERT INTO contract_lifecycle_events');
		const invoiceEvents = events.filter(([, params]) => (params as unknown[])[2] === 'INVOICE_EDITED');
		const changeEvent = events.find(([, params]) => (params as unknown[])[2] === 'CONDITIONS_UPDATED')!;
		const invoiceMeta = JSON.parse((invoiceEvents[0][1] as unknown[])[7] as string);
		const changeMeta = JSON.parse((changeEvent[1] as unknown[])[10] as string);

		expect(invoiceEvents).toHaveLength(1);
		expect(invoiceMeta).toMatchObject({
			source: 'contract_change',
			invoice_id: 'inv-11',
			header: { before: { invoice_terms_and_conditions: null }, after: { invoice_terms_and_conditions: 'Pago a 30 días' } },
		});
		expect(changeMeta.pending_terms).toMatchObject({ bulk_id: invoiceMeta.bulk_id, updated: ['inv-11'] });
		expect(changeMeta.pending_terms.skipped.map((skip: { reason: string }) => skip.reason)).toEqual(['sent_to_erp_draft', 'legacy_invoice']);
		expect(result.pending_terms).toMatchObject({ updated: ['inv-11'] });
		expect(runner.commitTransaction).toHaveBeenCalled();
	});

	it('400 errors[{ field: apply_to_pending }] si no hay cambio de condiciones de factura', async () => {
		const { service } = build(pendingTermsHandler);
		const error = await service
			.preview(CONTRACT_ID, request({ type: 'billing_conditions', auto_send_to_odoo: true, apply_to_pending: true }), HOLDING, today)
			.catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(BadRequestException);
		expect((error as BadRequestException).getResponse()).toMatchObject({ errors: [expect.objectContaining({ field: 'apply_to_pending' })] });
	});
});

describe('ContractChangesService.preview', () => {
	it('calcula con el mismo plan y no abre transacción ni escribe', async () => {
		const { service, dataSource, runner } = build();
		const preview = await service.preview(CONTRACT_ID, request({ type: 'item_remove', items: [{ item_id: LICENCIA }] }), HOLDING, today);

		expect(preview).toMatchObject({ type: 'item_remove', can_apply: true, contract: { before: { mrr: 1200 }, after: { mrr: 200 } } });
		expect(preview.items.added[0]).toMatchObject({ categoria: 'DOWNSELL', key: 'new:1', item_id: null });
		expect((dataSource as unknown as { createQueryRunner: jest.Mock }).createQueryRunner).not.toHaveBeenCalled();
		expect(runner.query).not.toHaveBeenCalled();
		expect(sqlOf((dataSource as unknown as { query: jest.Mock }).query).some((sql) => /^\s*(INSERT|UPDATE|DELETE)/.test(sql))).toBe(false);
	});
});

describe('ContractChangeRequestDto', () => {
	const validateDto = async (body: unknown) => flattenValidationErrors(await validate(plainToInstance(ContractChangeRequestDto, body)));

	it('exige fecha efectiva ISO, tipo conocido y valida los anidados de condiciones y tasas', async () => {
		expect(await validateDto({ effective_date: '15-11-2026', change: { type: 'nada' } })).toEqual([
			{ field: 'effective_date', message: 'Fecha efectiva inválida (YYYY-MM-DD)' },
			{ field: 'change.type', message: 'Tipo de cambio inválido' },
		]);
		expect(
			await validateDto({ effective_date: '2026-11-15', change: { type: 'billing_conditions', payment_terms: { kind: 'net', days: 900 } } })
		).toEqual([expect.objectContaining({ field: 'change.payment_terms.days' })]);
		expect(await validateDto({ effective_date: '2026-11-15', origin: { type: 'quote' }, change: { type: 'item_add', items: [] } })).toEqual([
			{ field: 'origin.quote_id', message: 'Indica la cotización de origen' },
		]);
		expect(
			await validateDto({
				effective_date: '2026-11-15',
				change: { type: 'item_remove', items: [{ item_id: LICENCIA }] },
				reason_id: CONTRACT_ID,
			})
		).toEqual([]);
	});
});

describe('ContractsController (modificaciones)', () => {
	const controller = (changes: Partial<ContractChangesService>) =>
		new ContractsController(
			{} as ContractsService,
			{} as ContractDraftsService,
			{} as ContractSubscriptionsService,
			{} as Contract360Service,
			{} as ContractBulkService,
			{} as ContractActivationService,
			{} as ConsumptionService,
			changes as ContractChangesService,
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

	it('rutas `:id/changes/preview` y `:id/changes` con 200, bajo SupabaseAuthGuard + HoldingScopeGuard; pasan holding, usuario e Idempotency-Key', async () => {
		expect(Reflect.getMetadata(GUARDS_METADATA, ContractsController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
		expect(Reflect.getMetadata(PATH_METADATA, ContractsController.prototype.changePreview)).toBe(':id/changes/preview');
		expect(Reflect.getMetadata(PATH_METADATA, ContractsController.prototype.applyChange)).toBe(':id/changes');
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.changePreview)).toBe(200);
		expect(Reflect.getMetadata(HTTP_CODE_METADATA, ContractsController.prototype.applyChange)).toBe(200);
		const preview = jest.fn().mockResolvedValue({ can_apply: true });
		const apply = jest.fn().mockResolvedValue({ applied: true });
		const body = request({ type: 'contract_cancel' });

		await controller({ preview }).changePreview('CTR-2026-001', body, HOLDING);
		expect(preview).toHaveBeenCalledWith('CTR-2026-001', body, HOLDING);
		await controller({ apply }).applyChange(CONTRACT_ID, body, HOLDING, { user: { sub: 'auth-1' } }, 'key-1');
		expect(apply).toHaveBeenCalledWith(CONTRACT_ID, body, HOLDING, 'auth-1', 'key-1');
	});
});

describe('ContractChangesService · bloque B2 (spec modificaciones §9)', () => {
	const sqlIndex = (runner: { query: jest.Mock }, needle: string) => sqlOf(runner.query).findIndex((sql) => sql.includes(needle));

	it('change_entity con new_entity: crea la razón social y su vínculo no principal antes de reasignar contrato y PE; el evento lleva el id real', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('INSERT INTO client_entities')
				? [{ id: 'entity-new' }]
				: sql.includes('FROM client_entities ce CROSS JOIN contracts c')
					? []
					: undefined
		);

		const result = await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'change_entity', new_entity: { legal_name: 'Cliente Norte SpA', tax_id: '76.543.210-K', country: 'Chile' } },
				{ effective_date: '2026-10-01' }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);

		expect(sqlOf(runner.query)[0]).toContain("set_config('sapira.writer', 'api', true)");
		const [[, entityParams]] = calls(runner.query, 'INSERT INTO client_entities');

		// `country_code` (ronda 3 de Configuración): sin catálogo de países en el mock queda null.
		expect(entityParams).toEqual([HOLDING, 'client-1', 'Cliente Norte SpA', '76.543.210-K', 'Chile', null, null, null, null]);
		expect(calls(runner.query, 'INSERT INTO client_entity_clients')[0][1]).toEqual(['entity-new', 'client-1', HOLDING]);
		expect(calls(runner.query, 'INSERT INTO client_entity_clients')[0][0]).toContain('is_primary) VALUES ($1, $2, $3, false)');
		expect(sqlIndex(runner, 'INSERT INTO client_entities')).toBeLessThan(sqlIndex(runner, 'UPDATE contracts SET'));
		expect(calls(runner.query, 'UPDATE contracts SET')[0][1]).toContain('entity-new');
		expect(calls(runner.query, 'UPDATE invoices SET client_entity_id')[0][1]).toContain('entity-new');
		const [[, eventParams]] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');
		const metadata = String(eventParams[10]);

		expect(metadata).toContain('"entity_created":true');
		expect(metadata).not.toContain('new:entity');
		expect(result.created.entity_id).toBe('entity-new');
	});

	it('change_entity con new_entity crea la razón social por el camino compartido con Cliente 360 (insertClientEntity)', async () => {
		const spy = jest.spyOn(entityWriter, 'insertClientEntity');
		const { service } = build((sql) =>
			sql.includes('INSERT INTO client_entities')
				? [{ id: 'entity-new' }]
				: sql.includes('FROM client_entities ce CROSS JOIN contracts c')
					? []
					: undefined
		);

		await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'change_entity', new_entity: { legal_name: 'Cliente Norte SpA', tax_id: '76.543.210-K', country: 'Chile' } },
				{ effective_date: '2026-10-01' }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);

		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0][1]).toBe(HOLDING);
		expect(spy.mock.calls[0][2]).toMatchObject({ client_id: 'client-1', legal_name: 'Cliente Norte SpA', tax_id: '76.543.210-K' });
		// Sin `makePrimaryIfNone`: la razón social del contrato queda como adicional del cliente.
		expect(spy.mock.calls[0][3]).toBeUndefined();
		spy.mockRestore();
	});

	it('renewal con precio nuevo: el ajuste apunta al id real del RENEWAL y el pacto aplicado queda ligado al evento (applied_event_id)', async () => {
		const { service, runner } = build((sql) => (sql.includes('INSERT INTO contract_scheduled_changes') ? [{ id: 'pact-new' }] : undefined));

		const result = await service.apply(
			CONTRACT_ID,
			request({ type: 'renewal', items: [{ item_id: LICENCIA, unit_price: 120 }] }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const items = calls(runner.query, 'INSERT INTO contract_items');

		expect(items[0][1][7]).toBe('RENEWAL');
		expect(items[1][1][7]).toBe('UPSELL');
		// related_item_id del ajuste = id real del RENEWAL insertado en la misma transacción.
		expect(items[1][1][23]).toBe(result.created.items['new:1']);
		const [[pactSql, pactParams]] = calls(runner.query, 'INSERT INTO contract_scheduled_changes');

		expect(pactSql).toContain("CASE WHEN $10 = 'applied' THEN now() END");
		expect(pactParams.slice(2, 10)).toEqual([LICENCIA, null, null, 'on_renewal', '2027-01-01', 'new_unit_price', 120, 'applied']);
		const link = calls(runner.query, 'UPDATE contract_scheduled_changes SET applied_event_id');

		expect(link[0][1]).toEqual([['pact-new'], HOLDING, 'event-1']);
		expect(sqlIndex(runner, 'INSERT INTO contract_lifecycle_events')).toBeLessThan(sqlIndex(runner, 'SET applied_event_id'));
		expect(result.created.scheduled_changes).toEqual(['pact-new']);
	});

	it('renewal con tasa de todo el contrato: extend_fx_rates mueve period_end de la fila al nuevo fin', async () => {
		const rate = {
			id: 'rate-1',
			purpose: 'invoice',
			from_currency: 'CLP',
			to_currency: 'USD',
			rate: 0.001,
			period_start: '2026-01-01',
			period_end: '2026-12-31',
		};
		const { service, runner } = build((sql) =>
			sql.includes('get_cutoff_date')
				? [{ ...contractDbRow, invoice_currency: 'USD', fx_invoice_policy: 'fixed', fx_invoice_rates: [rate], fx_rates: [rate] }]
				: undefined
		);

		await service.apply(
			CONTRACT_ID,
			request({ type: 'renewal', items: [{ item_id: LICENCIA }, { item_id: SOPORTE }] }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const [[sql, params]] = calls(runner.query, 'UPDATE contract_fx_period_rates SET period_end');

		expect(sql).toContain('Extendida al nuevo fin por renovación (v2)');
		expect(params).toEqual(['rate-1', HOLDING, '2027-12-31', CONTRACT_ID]);
	});

	it('reactivate (anular): limpia el churn, borra el espejo con su devengo y marca el evento de baja con reversed_by', async () => {
		const cancelledRow = { ...contractDbRow, status: 'Cancelado', contract_churn_date: '2026-12-01' };
		const mirror = {
			...itemDbRows[0],
			id: 'mirror-lic',
			categoria: 'CHURN',
			related_item_id: LICENCIA,
			start_date: '2026-12-01',
			quantity: '10',
			unit_price: '-100',
			monthly_price: '-1000',
			final_price: '-1000',
		};
		const { service, runner } = build((sql) =>
			sql.includes('get_cutoff_date')
				? [cancelledRow]
				: sql.includes('FROM contract_items ci') && sql.includes('LEFT JOIN prices')
					? [{ ...itemDbRows[0], churn_date: '2026-12-01' }, { ...itemDbRows[1], churn_date: '2026-12-01' }, mirror]
					: sql.includes('FROM invoices i') && sql.includes('ORDER BY i.issue_date')
						? MONTHS.map((mm) => (mm === '12' ? { ...invoiceDbRow(mm), status: 'Cancelada' } : invoiceDbRow(mm)))
						: sql.includes("event_type IN ('CHURN', 'DOWNSELL')")
							? [
									{
										id: 'event-churn',
										event_type: 'CHURN',
										items_affected: [LICENCIA, SOPORTE],
										effective_date: '2026-12-01',
										reversed: false,
									},
								]
							: undefined
		);

		const result = await service.apply(
			CONTRACT_ID,
			request({ type: 'reactivate' }, { effective_date: '2026-10-01' }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);

		expect(result.reactivation?.map((entry) => entry.branch)).toEqual(['annul', 'annul']);
		const clear = calls(runner.query, 'UPDATE contract_items SET churn_date');

		expect(clear.map(([, params]) => params)).toEqual([
			[LICENCIA, HOLDING, null, null],
			[SOPORTE, HOLDING, null, null],
		]);
		expect(sqlIndex(runner, 'DELETE FROM revenue_schedule_monthly WHERE contract_item_id')).toBeLessThan(
			sqlIndex(runner, 'DELETE FROM contract_items WHERE id = $1')
		);
		expect(calls(runner.query, 'DELETE FROM contract_items WHERE id = $1')[0][1]).toEqual(['mirror-lic', HOLDING, CONTRACT_ID]);
		expect(calls(runner.query, 'UPDATE contracts SET')[0][0]).toContain('status = $3');
		const [[markSql, markParams]] = calls(runner.query, "jsonb_build_object('reversed_by'");

		expect(markSql).toContain('UPDATE contract_lifecycle_events');
		expect(markParams).toEqual([['event-churn'], HOLDING, 'event-1']);
		const [[, eventParams]] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(eventParams[2]).toBe('CHURN_REVERSED');
	});

	it('item_add de ciclo propio: el INSERT lleva billing_anchor_day = día de inicio; loadContext lee el ciclo, las tasas con id y los pactos', async () => {
		const { service, runner, dataSource } = build((sql) =>
			sql.includes('FROM products') ? [{ id: 'p0000000-0000-4000-8000-00000000000c', name: 'Analítica' }] : undefined
		);

		await service.apply(
			CONTRACT_ID,
			request({
				type: 'item_add',
				items: [{ product_id: 'p0000000-0000-4000-8000-00000000000c', quantity: 1, unit_price: 300, billing_cycle: 'own' }],
			}),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const [[itemSql, itemParams]] = calls(runner.query, 'INSERT INTO contract_items');

		expect(itemSql).toContain('billing_period_price, billing_anchor_day');
		expect(itemParams[32]).toBe(15);
		const reads = sqlOf((dataSource as unknown as { query: jest.Mock }).query).concat(sqlOf(runner.query));

		expect(reads.find((sql) => sql.includes('get_cutoff_date'))).toContain("'id', r.id, 'purpose', r.purpose");
		expect(reads.find((sql) => sql.includes('FROM contract_items ci') && sql.includes('LEFT JOIN prices'))).toContain('ci.billing_anchor_day');
		expect(reads.some((sql) => sql.includes('FROM contract_scheduled_changes sc'))).toBe(true);
	});
});

describe('ContractChangesService · B2-4 / B2-5 (spec modificaciones §9.3.3, §9.3.5)', () => {
	const PROPOSAL = 'e0000000-0000-4000-8000-0000000000ee';

	it('pause: inserta la pausa después de los ítems, rehace el devengo después y liga la fila al evento (pause_event_id)', async () => {
		const { service, runner } = build((sql) => (sql.includes('INSERT INTO contract_item_pauses') ? [{ id: 'pause-1' }] : undefined));
		const result = await service.apply(
			CONTRACT_ID,
			request({ type: 'pause', items: [{ item_id: LICENCIA }], pause_start: '2026-11-15' }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const sql = sqlOf(runner.query);
		const [insert] = calls(runner.query, 'INSERT INTO contract_item_pauses');

		expect(insert[1]).toEqual([HOLDING, CONTRACT_ID, LICENCIA, '2026-11-15', null, false, 'scheduled', 'Pedido del cliente', 'user-1']);
		expect(firstIndex(sql, 'INSERT INTO contract_item_pauses')).toBeLessThan(firstIndex(sql, 'revenue_schedule_rebuild'));
		expect(calls(runner.query, 'SET pause_event_id')[0][1]).toEqual([['pause-1'], HOLDING, 'event-1']);
		expect(result.created).toMatchObject({ pauses: ['pause-1'], resumed_pauses: [] });
		// La PE de noviembre queda desde el 01-11 al 14-11 (billing_period_start sin cambio: COALESCE con null).
		const update = calls(runner.query, 'UPDATE invoice_items SET quantity').find(([, params]) => (params as unknown[])[0] === 'line-11-lic')!;

		expect(update[0]).toContain('billing_period_start = COALESCE($18::date, billing_period_start)');
		expect((update[1] as unknown[])[12]).toBe('2026-11-14');
		expect((update[1] as unknown[])[17]).toBeNull();
	});

	it('resume: cierra la pausa (pause_end, ended) y la liga con resume_event_id', async () => {
		const { service, runner } = build((sql) =>
			sql.includes('FROM contract_item_pauses WHERE contract_id')
				? [{ id: 'pause-1', contract_item_id: LICENCIA, pause_start: '2026-11-01', pause_end: null, extend_term: false, status: 'scheduled' }]
				: undefined
		);

		await service.apply(CONTRACT_ID, request({ type: 'resume', resume_date: '2026-12-01' }), HOLDING, 'auth-1', undefined, today);
		expect(calls(runner.query, 'UPDATE contract_item_pauses SET pause_end')[0][1]).toEqual([
			'pause-1',
			HOLDING,
			CONTRACT_ID,
			'2026-11-30',
			'ended',
		]);
		expect(calls(runner.query, 'SET resume_event_id')[0][1]).toEqual([['pause-1'], HOLDING, 'event-1']);
	});

	it('confirmar una propuesta: renewal con origin renewal_proposal marca la propuesta confirmed con confirmed_by_event_id', async () => {
		const { service, runner } = build((sql) =>
			sql.includes("event_type = 'RENEWAL_PROPOSED'") && sql.includes('metadata->>')
				? [{ id: PROPOSAL, status: 'open', items: [{ item_id: LICENCIA }] }]
				: undefined
		);

		await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'renewal', items: [{ item_id: LICENCIA }] },
				{ effective_date: '2026-12-15', origin: { type: 'renewal_proposal', event_id: PROPOSAL } }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const [confirm] = calls(runner.query, "jsonb_build_object('status', 'confirmed'");

		expect(confirm[0]).toContain(`event_type = 'RENEWAL_PROPOSED'`);
		expect(confirm[1]).toEqual([PROPOSAL, HOLDING, 'event-1']);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(JSON.parse((event[1] as unknown[])[10] as string).origin).toEqual({ type: 'renewal_proposal', event_id: PROPOSAL });
	});

	it('Notificaciones v2: tras confirmar, cierra la alerta "Renovación por confirmar" y los vencimientos ya decididos del contrato', async () => {
		const { service } = build((sql) => {
			// Después del commit la propuesta ya no está abierta y no quedan ítems sin decisión con ese fin.
			if (sql.includes("event_status = 'Pending'") || sql.includes('SELECT DISTINCT ci.end_date::text')) return [];
			return sql.includes("event_type = 'RENEWAL_PROPOSED'") && sql.includes('metadata->>')
				? [{ id: PROPOSAL, status: 'open', items: [{ item_id: LICENCIA }] }]
				: undefined;
		});
		const notifications = {
			listOpen: jest.fn(async (_holding: string, type: string) =>
				type === 'contract_renewal_proposed'
					? [{ id: 'n-proposal', action_payload: { event_id: PROPOSAL }, deduplication_key: `contracts:renewal-proposal:${PROPOSAL}` }]
					: type === 'contract_renewal_reminder'
						? [{ id: 'n-reminder', action_payload: {}, deduplication_key: `contracts:renewal-reminder:${CONTRACT_ID}:2026-12-14` }]
						: []
			),
			resolveOpen: jest.fn().mockResolvedValue(2),
		};

		(service as unknown as { notifications: unknown }).notifications = notifications;
		await service.apply(
			CONTRACT_ID,
			request(
				{ type: 'renewal', items: [{ item_id: LICENCIA }] },
				{ effective_date: '2026-12-15', origin: { type: 'renewal_proposal', event_id: PROPOSAL } }
			),
			HOLDING,
			'auth-1',
			undefined,
			today
		);

		expect(notifications.listOpen).toHaveBeenCalledWith(HOLDING, 'contract_renewal_proposed', CONTRACT_ID);
		expect(notifications.resolveOpen).toHaveBeenCalledWith(HOLDING, { ids: ['n-reminder', 'n-proposal'] });
	});

	it('sin NotificationsService (o si falla) el cambio igual se aplica: el cierre de alertas nunca lanza', async () => {
		const { service } = build();

		await expect(service.closeResolvedAlerts(CONTRACT_ID, HOLDING)).resolves.toBe(0);
		(service as unknown as { notifications: unknown }).notifications = {
			listOpen: jest.fn().mockRejectedValue(new Error('sin base')),
			resolveOpen: jest.fn(),
		};
		await expect(service.closeResolvedAlerts(CONTRACT_ID, HOLDING)).resolves.toBe(0);
	});

	it('confirmar una propuesta ya omitida → 409 blocked renewal_proposal_not_open', async () => {
		const { service } = build((sql) =>
			sql.includes("event_type = 'RENEWAL_PROPOSED'") && sql.includes('metadata->>')
				? [{ id: PROPOSAL, status: 'dismissed', items: [] }]
				: undefined
		);

		await expect(
			service.apply(
				CONTRACT_ID,
				request({ type: 'renewal', items: [{ item_id: LICENCIA }] }, { origin: { type: 'renewal_proposal', event_id: PROPOSAL } }),
				HOLDING,
				'auth-1',
				undefined,
				today
			)
		).rejects.toMatchObject({ response: expect.objectContaining({ code: 'blocked' }) });
	});
});

describe('ContractChangesService · item_update (spec modificaciones §9.2, corregir un dato)', () => {
	/** Las líneas de noviembre de Licencia vienen con la glosa escrita a mano (`description_locked`). */
	const withLockedNovember = (sql: string) =>
		sql.includes('FROM invoice_items ii') && sql.includes('ii.description_locked') && sql.includes('ORDER BY ii.billing_period_start')
			? MONTHS.flatMap(lineDbRows).map((line) => ({ ...line, description_locked: line.id === 'line-11-lic' }))
			: undefined;

	it('escribe la cuenta y regenera solo las glosas de las PE no protegidas del ítem; sin RSM, sin facturas, evento ITEM_CORRECTED', async () => {
		const { service, runner, descriptions } = build(withLockedNovember);
		const regenerate = jest
			.spyOn(descriptions, 'regenerateLines')
			.mockResolvedValue([
				{ line_id: 'line-10-lic', invoice_id: 'inv-10', before: 'Periodo 10', after: 'Licencia Norte', length: 14 } as never,
			]);
		const result = await service.apply(
			CONTRACT_ID,
			request({ type: 'item_update', items: [{ item_id: LICENCIA, account: '  Norte  ' }] }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const sql = sqlOf(runner.query);
		const [update] = calls(runner.query, 'UPDATE contract_items SET account');

		expect(update[1]).toEqual([LICENCIA, HOLDING, 'Norte']);
		// PE de octubre y diciembre (noviembre está protegida; Soporte y las emitidas no se tocan).
		expect(regenerate).toHaveBeenCalledWith(runner, CONTRACT_ID, HOLDING, ['line-10-lic', 'line-12-lic']);
		expect(firstIndex(sql, 'UPDATE contract_items SET account')).toBeLessThan(firstIndex(sql, 'INSERT INTO contract_lifecycle_events'));
		expect(sql.some((text) => text.includes('revenue_schedule_rebuild'))).toBe(false);
		expect(sql.some((text) => text.includes('UPDATE invoice_items SET quantity') || text.includes('INSERT INTO invoices'))).toBe(false);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');
		const metadata = JSON.parse(event[1][10] as string) as Row;

		expect(event[1][2]).toBe('ITEM_CORRECTED');
		expect(event[1][8]).toBe(0);
		expect(metadata.items).toEqual([
			{ item_id: LICENCIA, product_name: 'Licencia', changes: [{ field: 'account', before: null, after: 'Norte' }] },
		]);
		expect(metadata.descriptions_regenerated).toEqual([
			{ line_id: 'line-10-lic', invoice_id: 'inv-10', before: 'Periodo 10', after: 'Licencia Norte' },
		]);
		expect(result.items_after).toEqual([
			{
				item_id: LICENCIA,
				product_name: 'Licencia',
				account_before: null,
				account: 'Norte',
				changes: [{ field: 'account', before: null, after: 'Norte' }],
			},
		]);
		expect(result.warnings.map((warning) => warning.code)).toEqual(['pending_descriptions_updated']);
		expect(result.rsm.mrr_delta).toBe(0);
	});

	it('fecha de inicio (CTR-2026-191): escribe el inicio con plazo y valor, genera la PE del tramo nuevo y reconstruye el devengo', async () => {
		const { service, runner } = build();
		const result = await service.apply(
			CONTRACT_ID,
			request({ type: 'item_update', items: [{ item_id: LICENCIA, start_date: '2025-12-01' }] }, { effective_date: '2026-09-28' }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const sql = sqlOf(runner.query);
		const [update] = calls(runner.query, 'UPDATE contract_items SET start_date');

		expect(update[1]).toEqual([LICENCIA, HOLDING, '2025-12-01', 13, 13000, 13000]);
		expect(sql.some((text) => text.includes('INSERT INTO invoices'))).toBe(true);
		expect(sql.some((text) => text.includes('revenue_schedule_rebuild'))).toBe(true);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(event[1][2]).toBe('ITEM_CORRECTED');
		expect(result.invoices.created.map((invoice) => [invoice.billing_period_start, invoice.billing_period_end, invoice.subtotal])).toEqual([
			['2025-12-01', '2025-12-31', 1000],
		]);
	});

	it('corrección de cantidad: escribe el ítem en su lugar, reescribe las PE, registra el motivo del ajuste, regenera glosas después y reconstruye el devengo completo', async () => {
		const { service, runner, descriptions } = build();
		const regenerate = jest.spyOn(descriptions, 'regenerateLines').mockResolvedValue([]);
		const result = await service.apply(
			CONTRACT_ID,
			request({ type: 'item_update', items: [{ item_id: LICENCIA, quantity: 12 }] }, { effective_date: '2026-09-28' }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		const sql = sqlOf(runner.query);
		const [update] = calls(runner.query, 'UPDATE contract_items SET');

		expect(update[0]).toContain('quantity = $5');
		expect(update[0]).toContain('monthly_price');
		expect(update[0]).not.toContain('categoria');
		expect(update[0]).not.toContain('booking_date');
		expect(calls(runner.query, 'INSERT INTO contract_items')).toHaveLength(0);
		expect(calls(runner.query, 'INSERT INTO invoice_adjustments').map((call) => call[1])).toEqual([
			['inv-10', HOLDING, 'correction', 600, expect.stringContaining('parte 1 de 3'), 'user-1'],
			['inv-11', HOLDING, 'correction', 600, expect.stringContaining('parte 2 de 3'), 'user-1'],
			['inv-12', HOLDING, 'correction', 600, expect.stringContaining('parte 3 de 3'), 'user-1'],
		]);
		expect(regenerate).toHaveBeenCalledWith(runner, CONTRACT_ID, HOLDING, ['line-10-lic', 'line-11-lic', 'line-12-lic']);
		expect(firstIndex(sql, 'UPDATE invoice_items SET quantity')).toBeLessThan(firstIndex(sql, 'INSERT INTO invoice_adjustments'));
		expect(calls(runner.query, 'revenue_schedule_rebuild')[0][1]).toEqual([CONTRACT_ID, '2026-01-01']);
		// Ninguna emitida se toca ni recibe NC.
		expect(calls(runner.query, 'UPDATE invoice_items SET quantity').map((call) => call[1][0])).toEqual([
			'line-10-lic',
			'line-11-lic',
			'line-12-lic',
		]);
		expect(calls(runner.query, 'INSERT INTO invoices')).toHaveLength(0);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(event[1][2]).toBe('ITEM_CORRECTED');
		expect(result.issued_difference).toMatchObject({ amount: 1800 });
	});

	it('el aviso pending_descriptions_updated es informativo: se aplica sin motivo', async () => {
		const { service, runner, descriptions } = build();

		jest.spyOn(descriptions, 'regenerateLines').mockResolvedValue([]);
		const result = await service.apply(
			CONTRACT_ID,
			request({ type: 'item_update', items: [{ item_id: LICENCIA, account: 'Norte' }] }, { reason: undefined, reason_id: undefined }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);

		expect(result.warnings.map((warning) => warning.code)).toEqual(['pending_descriptions_updated']);
		expect(calls(runner.query, 'UPDATE contract_items SET account').length).toBe(1);
	});

	it('otro ítem con cuenta; ítem ajeno → 409 blocked item_not_found sin escribir', async () => {
		const { service, runner, descriptions } = build();

		jest.spyOn(descriptions, 'regenerateLines').mockResolvedValue([]);
		await service.apply(
			CONTRACT_ID,
			request({ type: 'item_update', items: [{ item_id: SOPORTE, account: 'Sur' }] }),
			HOLDING,
			'auth-1',
			undefined,
			today
		);
		expect(calls(runner.query, 'UPDATE contract_items SET account')[0][1]).toEqual([SOPORTE, HOLDING, 'Sur']);

		const other = build();

		await expect(
			other.service.apply(
				CONTRACT_ID,
				request({ type: 'item_update', items: [{ item_id: 'e0000000-0000-4000-8000-000000000099', account: 'Sur' }] }),
				HOLDING,
				'auth-1',
				undefined,
				today
			)
		).rejects.toMatchObject({ response: expect.objectContaining({ code: 'blocked' }) });
		expect(calls(other.runner.query, 'UPDATE contract_items').length).toBe(0);
	});
});

describe('ContractChangesService.extendHorizonForHolding (job contracts-extend-horizon)', () => {
	/** Licencia sin término (sin plazo ni fin): el horizonte llega a ago-2027 desde hoy (28-09-2026). */
	const openEnded = (sql: string) => {
		if (sql.includes('SELECT DISTINCT c.id FROM contracts c')) return [{ id: CONTRACT_ID }];
		if (sql.includes('FROM contract_items ci') && sql.includes('LEFT JOIN prices'))
			return itemDbRows.map((row) => (row.id === LICENCIA ? { ...row, term_months: null, end_date: null } : row));

		return undefined;
	};

	it('por contrato: costura, bloqueo, crea las Por Emitir que faltan y un evento HORIZON_EXTENDED del sistema; sin devengo', async () => {
		const { service, runner } = build(openEnded);
		const extended = await service.extendHorizonForHolding(HOLDING, 'system', today);
		const sql = sqlOf(runner.query);

		expect(extended).toBe(1);
		expect(sql[0]).toContain('sapira.writer');
		expect(firstIndex(sql, 'FOR UPDATE')).toBeLessThan(firstIndex(sql, 'INSERT INTO invoices'));
		expect(calls(runner.query, 'INSERT INTO invoices')).toHaveLength(8);
		expect(calls(runner.query, 'revenue_schedule_rebuild')).toHaveLength(0);
		const [event] = calls(runner.query, 'INSERT INTO contract_lifecycle_events');

		expect(event[1][2]).toBe('HORIZON_EXTENDED');
		expect(event[1][6]).toBe('system');
		expect(runner.commitTransaction).toHaveBeenCalledTimes(1);
	});

	it('sin nada que extender (ítems con plazo) no escribe ni registra evento', async () => {
		const { service, runner } = build((sql) => (sql.includes('SELECT DISTINCT c.id FROM contracts c') ? [{ id: CONTRACT_ID }] : undefined));

		expect(await service.extendHorizonForHolding(HOLDING, 'system', today)).toBe(0);
		expect(calls(runner.query, 'INSERT INTO')).toHaveLength(0);
		expect(runner.rollbackTransaction).toHaveBeenCalled();
	});
});
