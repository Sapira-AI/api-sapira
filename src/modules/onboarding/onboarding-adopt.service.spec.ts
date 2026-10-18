import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { fakeDb, Handler } from '@/modules/settings/fake-db.testing-spec';

import { adoptedStatus, allocateCoverage, scaleLines, splitExact } from './onboarding-adopt';
import { ADOPTED_EVENT_TYPE, OnboardingAdoptService } from './onboarding-adopt.service';

jest.mock('@/modules/contracts/api-written-fields', () => ({ refreshInvoiceSystemAmounts: jest.fn(async () => undefined) }));

const HOLDING = '11111111-1111-4111-8111-111111111111';
const ACTOR = { authId: 'auth-1', userId: 'user-1' };
const CLIENT = 'cl-1';
const CONTRACT = 'ct-1';
const LEGACY = '55555555-5555-4555-8555-555555555555';
const LEGACY_2 = '66666666-6666-4666-8666-666666666666';
const PENDING_MAY = 'inv-may';
const EMITTED_APR = 'inv-apr';

const legacyRow = (overrides: Record<string, unknown> = {}) => ({
	id: LEGACY,
	holding_id: HOLDING,
	invoice_number: 'FAC 027141',
	issue_date: '2026-05-20',
	due_date: '2026-06-19',
	status: 'Pagada',
	invoice_currency: 'CLP',
	amount_invoice_currency: '1200000',
	vat: '228000',
	total_invoice_currency: '1428000',
	fx_contract_to_invoice: null,
	client_id: CLIENT,
	client_name: 'Punto Azul',
	client_entity_id: 'ce-1',
	entity_legal_name: 'Punto Azul SpA',
	company_id: 'co-1',
	company_legal_name: 'Simplit SpA',
	erp_invoice_id: 191000,
	source_system: 'odoo',
	pdf_url: null,
	reconciliation_status: 'mrr_legacy',
	reconciled_invoice_id: null,
	has_history: true,
	...overrides,
});

const contractRow = (overrides: Record<string, unknown> = {}) => ({
	id: CONTRACT,
	contract_number: 'CTR-2026-158',
	status: 'Activo',
	contract_currency: 'CLP',
	client_entity_id: 'ce-1',
	company_id: 'co-1',
	first_month: '2026-04',
	last_month: '2026-12',
	pending_months: ['2026-05', '2026-10'],
	...overrides,
});

const scheduleRows = () => [
	{
		id: EMITTED_APR,
		invoice_number: 'FAC 027084',
		status: 'Pagada',
		issue_date: '2026-04-18',
		odoo_invoice_id: 190241,
		amount_contract_currency: '1128580',
		vat: '214430.2',
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		fx_contract_to_invoice: '1',
		document_type: 'FACTURA',
	},
	{
		id: PENDING_MAY,
		invoice_number: null,
		status: 'Por Emitir',
		issue_date: '2026-05-01',
		odoo_invoice_id: null,
		amount_contract_currency: '1128580',
		vat: '214430.2',
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		fx_contract_to_invoice: '1',
		document_type: 'FACTURA',
	},
	{
		id: 'inv-jun',
		invoice_number: 'FAC 027412',
		status: 'Pagada',
		issue_date: '2026-06-26',
		odoo_invoice_id: 192959,
		amount_contract_currency: '1147970',
		vat: '218114.3',
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		fx_contract_to_invoice: '1',
		document_type: 'FACTURA',
	},
	{
		id: 'inv-oct',
		invoice_number: null,
		status: 'Por Emitir',
		issue_date: '2026-10-01',
		odoo_invoice_id: null,
		amount_contract_currency: '1128580',
		vat: '214430.2',
		contract_currency: 'CLP',
		invoice_currency: 'CLP',
		fx_contract_to_invoice: '1',
		document_type: 'FACTURA',
	},
];

const lineRows = () => [
	{
		id: 'li-1',
		contract_item_id: 'ci-1',
		product_id: 'p-1',
		description: 'PATHFINDER+ · 10 vehículos',
		quantity: '10',
		unit_of_measure: 'UND',
		discount_pct: '0',
		subtotal_contract_currency: '1000000',
		tax_amount_contract_currency: '190000',
		tax_code: null,
		billing_period_start: '2026-05-01',
		billing_period_end: '2026-05-31',
		quantity_source: 'fixed',
		pricing_breakdown: null,
		contract_currency: 'CLP',
	},
	{
		id: 'li-2',
		contract_item_id: 'ci-2',
		product_id: 'p-2',
		description: 'Soporte',
		quantity: '1',
		unit_of_measure: 'UND',
		discount_pct: '0',
		subtotal_contract_currency: '128580',
		tax_amount_contract_currency: '24430.2',
		tax_code: null,
		billing_period_start: '2026-05-01',
		billing_period_end: '2026-05-31',
		quantity_source: 'fixed',
		pricing_breakdown: null,
		contract_currency: 'CLP',
	},
];

function build(
	handlers: Handler[] = [],
	legacy: Record<string, unknown>[] = [legacyRow(), legacyRow({ id: LEGACY_2, invoice_number: 'FAC 027200' })],
	schedule = scheduleRows()
) {
	const db = fakeDb([
		...handlers,
		['FROM invoices_legacy il', (params) => legacy.filter((row) => (params[1] as string[]).includes(String(row.id)))],
		['FROM mrr_legacy m WHERE m.holding_id = $1 AND m.invoice_legacy_id = $2', () => [{ month: '2026-05' }]],
		['FROM contracts c', () => [contractRow()]],
		['SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 AND deleted_at IS NULL', () => [{ id: 'ct-other' }]],
		['FOR UPDATE', () => [{ id: CONTRACT }]],
		['FROM invoices i WHERE i.holding_id = $1 AND i.contract_id = $2', () => schedule],
		['FROM invoice_items ii', () => lineRows()],
		[
			'SELECT status, invoice_number, issue_date',
			() => [
				{
					status: 'Por Emitir',
					invoice_number: null,
					issue_date: '2026-05-01',
					amount_contract_currency: '1128580',
					amount_invoice_currency: '1128580',
					total_invoice_currency: '1343010.2',
					invoice_currency: 'CLP',
					contract_currency: 'CLP',
					fx_contract_to_invoice: '1',
					vat: '214430.2',
				},
			],
		],
		['UPDATE invoices SET status', () => [{ id: PENDING_MAY }]],
		['INSERT INTO invoices (', () => [{ id: 'inv-new' }]],
		['SELECT due_date FROM invoices_legacy', () => [{ due_date: '2026-06-19' }]],
		['SELECT source_system FROM invoices_legacy', () => [{ source_system: 'odoo' }]],
		['SELECT pdf_url FROM invoices_legacy', () => [{ pdf_url: null }]],
	]);

	return { db, service: new OnboardingAdoptService(db as unknown as DataSource) };
}

describe('adoptar · helpers puros', () => {
	it('splitExact reparte a centavos y cuadra el resto en la parte mayor', () => {
		expect(splitExact(100, [1 / 3, 1 / 3, 1 / 3])).toEqual([33.34, 33.33, 33.33]);
		expect(splitExact(0, [0.5, 0.5])).toEqual([0, 0]);
		expect(splitExact(10, [])).toEqual([]);
	});

	it('scaleLines reescala por peso del neto actual, reparte el IVA y convierte a moneda de factura con fx', () => {
		const lines = scaleLines(
			[
				{
					id: 'a',
					contract_item_id: 'ci-1',
					product_id: null,
					description: 'A',
					quantity: 10,
					unit_of_measure: 'UND',
					discount_pct: 0,
					subtotal_contract_currency: 800,
					tax_amount_contract_currency: 0,
					tax_code: null,
					billing_period_start: null,
					billing_period_end: null,
					quantity_source: null,
					pricing_breakdown: null,
					contract_currency: 'USD',
				},
				{
					id: 'b',
					contract_item_id: 'ci-2',
					product_id: null,
					description: 'B',
					quantity: 1,
					unit_of_measure: 'UND',
					discount_pct: 0,
					subtotal_contract_currency: 200,
					tax_amount_contract_currency: 0,
					tax_code: null,
					billing_period_start: null,
					billing_period_end: null,
					quantity_source: null,
					pricing_breakdown: null,
					contract_currency: 'USD',
				},
			],
			500,
			95,
			900
		);

		expect(lines.map((line) => line.subtotal_contract_currency)).toEqual([400, 100]);
		expect(lines.map((line) => line.tax_amount_contract_currency)).toEqual([76, 19]);
		expect(lines.map((line) => line.total_contract_currency)).toEqual([476, 119]);
		expect(lines[0].unit_price_contract_currency).toBe(40);
		expect(lines.map((line) => line.subtotal_invoice_currency)).toEqual([360000, 90000]);
		expect(lines.map((line) => line.total_invoice_currency)).toEqual([428400, 107100]);
	});

	it('scaleLines con todas las líneas en 0 reparte a partes iguales y la cantidad 0 pasa a 1', () => {
		const [a, b] = scaleLines(
			[
				{
					id: 'a',
					contract_item_id: null,
					product_id: null,
					description: 'A',
					quantity: 0,
					unit_of_measure: null,
					discount_pct: 0,
					subtotal_contract_currency: 0,
					tax_amount_contract_currency: 0,
					tax_code: null,
					billing_period_start: null,
					billing_period_end: null,
					quantity_source: null,
					pricing_breakdown: null,
					contract_currency: 'CLP',
				},
				{
					id: 'b',
					contract_item_id: null,
					product_id: null,
					description: 'B',
					quantity: 2,
					unit_of_measure: null,
					discount_pct: 0,
					subtotal_contract_currency: 0,
					tax_amount_contract_currency: 0,
					tax_code: null,
					billing_period_start: null,
					billing_period_end: null,
					quantity_source: null,
					pricing_breakdown: null,
					contract_currency: 'CLP',
				},
			],
			101,
			0,
			1
		);

		expect([a.subtotal_contract_currency, b.subtotal_contract_currency]).toEqual([50.5, 50.5]);
		expect(a.quantity).toBe(1);
		expect(a.unit_price_contract_currency).toBe(50.5);
	});

	it('allocateCoverage reparte el neto en proporción al neto de cada destino (a partes iguales si ninguno tiene)', () => {
		expect(allocateCoverage(300, [100, 200])).toEqual([100, 200]);
		expect(allocateCoverage(222.41, [58.2, 71.22, 92.99])).toEqual([58.2, 71.22, 92.99]);
		expect(allocateCoverage(100, [null, 0])).toEqual([50, 50]);
	});

	it('adoptedStatus conserva Pagada/Vencida/Enviada y el resto pasa a Emitida', () => {
		expect(adoptedStatus('Pagada')).toBe('Pagada');
		expect(adoptedStatus('Vencida')).toBe('Vencida');
		expect(adoptedStatus('Enviada')).toBe('Enviada');
		expect(adoptedStatus('Borrador')).toBe('Emitida');
		expect(adoptedStatus(null)).toBe('Emitida');
	});
});

describe('adoptar · vista previa', () => {
	it('sin contrato: trae el cliente y sus contratos candidatos, sin destino y sin poder aplicar', async () => {
		const { service } = build();
		const preview = await service.preview(HOLDING, { invoices: [{ invoice_id: LEGACY }] });

		expect(preview.client).toEqual({ id: CLIENT, name: 'Punto Azul' });
		expect(preview.contracts).toHaveLength(1);
		expect(preview.contracts[0]).toMatchObject({ contract_number: 'CTR-2026-158', pending_months: ['2026-05', '2026-10'] });
		expect(preview.contract).toBeNull();
		expect(preview.invoices[0]).toMatchObject({ months: ['2026-05'], targets: [], amounts: null, history_months: ['2026-05'], can_apply: false });
		expect(preview.can_apply).toBe(false);
	});

	it('con contrato: el mes de emisión tiene una Por Emitir → reemplazar, con montos en moneda de contrato y estado de la previa', async () => {
		const { service } = build();
		const preview = await service.preview(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }] });
		const [item] = preview.invoices;

		expect(item.targets).toEqual([
			{
				month: '2026-05',
				kind: 'replace',
				invoice_id: PENDING_MAY,
				target_amount_contract_currency: 1128580,
				coverage_contract_currency: 1200000,
				remainder_contract_currency: null,
				template_invoice_number: null,
			},
		]);
		expect(item.amounts).toEqual({
			contract_currency: 'CLP',
			invoice_currency: 'CLP',
			fx_contract_to_invoice: 1,
			amount_contract_currency: 1200000,
			vat_contract_currency: 228000,
			status: 'Pagada',
		});
		expect(item.blockers).toEqual([]);
		expect(item.warnings).toEqual([]);
		expect(item.can_apply).toBe(true);
		expect(preview.can_apply).toBe(true);
	});

	it('mes sin Por Emitir ni emitida → crear con la factura más cercana como plantilla; mes con emitida → bloqueo', async () => {
		const { service } = build();
		const preview = await service.preview(HOLDING, {
			contract_id: CONTRACT,
			invoices: [
				{ invoice_id: LEGACY, months: ['2026-07'] },
				{ invoice_id: LEGACY, months: ['2026-04'] },
			],
		});
		const [july, april] = preview.invoices;

		expect(july.targets[0]).toMatchObject({
			month: '2026-07',
			kind: 'create',
			invoice_id: 'inv-jun',
			template_invoice_number: 'FAC 027412',
			coverage_contract_currency: 1200000,
		});
		expect(july.can_apply).toBe(true);
		expect(april.targets).toEqual([]);
		expect(april.blockers.map((issue) => issue.code)).toEqual(['month_already_invoiced']);
		expect(preview.can_apply).toBe(false);
	});

	it('bloqueos: ya adoptada, sin cliente, antes del contrato, borrador en el ERP, contrato de otro cliente', async () => {
		const legacy = [
			legacyRow({ id: LEGACY, reconciliation_status: 'migrated', reconciled_invoice_id: 'inv-x' }),
			legacyRow({ id: LEGACY_2, client_id: null, client_name: null }),
		];
		const schedule = scheduleRows().map((row) => (row.id === PENDING_MAY ? { ...row, odoo_invoice_id: 198804 } : row));
		const { service } = build([], legacy, schedule);
		const preview = await service.preview(HOLDING, {
			contract_id: CONTRACT,
			invoices: [{ invoice_id: LEGACY }, { invoice_id: LEGACY_2 }],
		});

		expect(preview.invoices[0].blockers.map((issue) => issue.code)).toEqual(['already_adopted']);
		expect(preview.invoices[1].blockers.map((issue) => issue.code)).toEqual(['no_client']);

		const draft = await service.preview(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }] });

		expect(draft.invoices[0].blockers.map((issue) => issue.code)).toEqual(['already_adopted']);

		const { service: clean } = build([], [legacyRow()], schedule);
		const erp = await clean.preview(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }] });

		expect(erp.invoices[0].blockers.map((issue) => issue.code)).toEqual(['erp_draft']);
		const before = await clean.preview(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY, months: ['2026-03'] }] });

		expect(before.invoices[0].blockers.map((issue) => issue.code)).toEqual(['before_contract']);
		const other = await clean.preview(HOLDING, { contract_id: 'ct-other', invoices: [{ invoice_id: LEGACY }] });

		expect(other.contract).toBeNull();
		expect(other.invoices[0].blockers.map((issue) => issue.code)).toEqual(['contract_other_client']);
	});

	it('moneda distinta: usa el fx de la previa o el de la Por Emitir; sin ninguno, bloqueo fx_missing; avisos de monto, razón social y compañía', async () => {
		const usd = scheduleRows().map((row) => ({
			...row,
			contract_currency: 'USD',
			amount_contract_currency: '1300',
			fx_contract_to_invoice: null,
		}));
		const { service } = build(
			[['FROM contracts c', () => [contractRow({ contract_currency: 'USD', client_entity_id: 'ce-2', company_id: 'co-2' })]]],
			[legacyRow({ fx_contract_to_invoice: null })],
			usd
		);
		const missing = await service.preview(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }] });

		expect(missing.invoices[0].blockers.map((issue) => issue.code)).toEqual(['fx_missing']);

		const { service: withFx } = build(
			[['FROM contracts c', () => [contractRow({ contract_currency: 'USD', client_entity_id: 'ce-2', company_id: 'co-2' })]]],
			[legacyRow({ fx_contract_to_invoice: '950' })],
			usd
		);
		const ok = await withFx.preview(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }] });
		const [item] = ok.invoices;

		expect(item.amounts).toMatchObject({
			contract_currency: 'USD',
			invoice_currency: 'CLP',
			fx_contract_to_invoice: 950,
			amount_contract_currency: 1263.16,
			vat_contract_currency: 240,
		});
		expect(item.warnings.map((issue) => issue.code).sort()).toEqual(['company_differs', 'entity_differs']);
		expect(item.can_apply).toBe(true);

		const { service: far } = build(
			[['FROM contracts c', () => [contractRow({ contract_currency: 'USD' })]]],
			[legacyRow({ fx_contract_to_invoice: '950', amount_invoice_currency: '2000000' })],
			usd
		);
		const amount = await far.preview(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }] });

		expect(amount.invoices[0].warnings.map((issue) => issue.code)).toEqual(['amount_differs']);
	});

	it('varios meses: reparte el neto en proporción a cada destino; keep_remainder deja el resto de la Por Emitir; dos previas no toman la misma Por Emitir', async () => {
		const { service } = build();
		const preview = await service.preview(HOLDING, {
			contract_id: CONTRACT,
			invoices: [{ invoice_id: LEGACY, months: ['2026-05', '2026-10'], keep_remainder: true }],
		});
		const [item] = preview.invoices;

		// 1.200.000 entre dos Por Emitir iguales (1.128.580 cada una): 600.000 y 600.000; remanente 528.580 en cada una.
		expect(
			item.targets.map((target) => [target.month, target.kind, target.coverage_contract_currency, target.remainder_contract_currency])
		).toEqual([
			['2026-05', 'replace', 600000, 528580],
			['2026-10', 'replace', 600000, 528580],
		]);
		expect(item.warnings).toEqual([]);
		expect(item.can_apply).toBe(true);

		const twice = await service.preview(HOLDING, {
			contract_id: CONTRACT,
			invoices: [{ invoice_id: LEGACY }, { invoice_id: LEGACY_2 }],
		});

		expect(twice.invoices[0].targets[0]).toMatchObject({ kind: 'replace', invoice_id: PENDING_MAY });
		// La segunda previa del mismo mes ya no encuentra la Por Emitir de mayo: se crea con plantilla.
		expect(twice.invoices[1].targets[0]).toMatchObject({ kind: 'create' });
	});

	it('factura previa inexistente → 404', async () => {
		const { service } = build();

		await expect(service.preview(HOLDING, { invoices: [{ invoice_id: '77777777-7777-4777-8777-777777777777' }] })).rejects.toBeInstanceOf(
			NotFoundException
		);
	});
});

describe('adoptar · aplicar', () => {
	it('reemplaza la Por Emitir con número, fechas, montos, estado e id del ERP; reescala líneas; saca el histórico; deja eventos', async () => {
		const { db, service } = build();
		const result = await service.apply(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }], notes: 'Suelta de mayo' }, ACTOR);

		expect(result).toMatchObject({
			applied: true,
			adopted: [
				{
					previous_invoice_id: LEGACY,
					invoice_number: 'FAC 027141',
					invoices: [{ invoice_id: PENDING_MAY, month: '2026-05', created: false, remainder_invoice_id: null }],
				},
			],
		});
		const [update] = db.statements('UPDATE invoices SET status');

		expect(update.params.slice(0, 13)).toEqual([
			PENDING_MAY,
			HOLDING,
			'Pagada',
			'FAC 027141',
			'2026-05-20',
			'2026-06-19',
			'CLP',
			1,
			1200000,
			228000,
			1200000,
			1428000,
			LEGACY,
		]);
		expect(update.params[14]).toBe(191000);
		expect(String(update.params[16])).toContain('Adoptada desde la factura previa FAC 027141 (2026-05-20): Suelta de mayo');
		const lines = db.statements('UPDATE invoice_items SET quantity');

		expect(lines).toHaveLength(2);
		// 1.200.000 repartido por peso del neto actual (1.000.000 / 1.128.580 = 88,6 %): 1.063.283,06 + 136.716,94; IVA 228.000 igual.
		expect(lines[0].params.slice(0, 7)).toEqual(['li-1', HOLDING, 10, 106328.306, 1063283.06, 202023.78, 1265306.84]);
		expect(lines[1].params.slice(0, 7)).toEqual(['li-2', HOLDING, 1, 136716.94, 136716.94, 25976.22, 162693.16]);
		expect(lines[0].params[13]).toBe('previous_invoice');
		expect(db.statements('SELECT revenue_schedule_rebuild')[0].params).toEqual([CONTRACT, '2026-05-01']);
		expect(db.statements('DELETE FROM mrr_legacy')[0].params).toEqual([HOLDING, LEGACY]);
		expect(db.statements("UPDATE invoices_legacy SET reconciliation_status = 'migrated'")[0].params).toEqual([
			HOLDING,
			LEGACY,
			PENDING_MAY,
			CONTRACT,
		]);
		expect(db.statements('INSERT INTO contract_lifecycle_events')[0].params[2]).toBe(ADOPTED_EVENT_TYPE);
		expect(db.statements('INSERT INTO onboarding_events')[0].params[1]).toBe('previous_invoice_adopted');
		expect(db.committed()).toBe(1);
	});

	it('crea la factura cuando el mes no tiene Por Emitir, con las líneas de la plantilla y el período del mes', async () => {
		const { db, service } = build();
		const result = await service.apply(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY, months: ['2026-07'] }] }, ACTOR);

		expect(result.adopted[0].invoices).toEqual([{ invoice_id: 'inv-new', created: true, month: '2026-07', remainder_invoice_id: null }]);
		const [insert] = db.statements('INSERT INTO invoices (');

		expect(insert.params.slice(0, 5)).toEqual(['inv-jun', HOLDING, CONTRACT, '2026-05-20', '2026-06-19']);
		expect(insert.params[13]).toBe('FAC 027141');
		const lines = db.statements('INSERT INTO invoice_items');

		expect(lines).toHaveLength(2);
		expect(lines[0].params[0]).toBe('inv-new');
		expect(lines[0].params[22]).toBe('2026-07-01');
		expect(lines[0].params[23]).toBe('2026-07-31');
		expect(db.statements('UPDATE invoices SET status')).toHaveLength(0);
		expect(db.statements('SELECT revenue_schedule_rebuild')[0].params).toEqual([CONTRACT, '2026-07-01']);
	});

	it('cobertura parcial con remanente: inserta la Por Emitir del resto antes de reescribir la original, con split_from y legacy_partial', async () => {
		const { db, service } = build([['INSERT INTO invoices (', (params) => [{ id: params[6] === 'legacy_partial' ? 'inv-rem' : 'inv-new' }]]]);
		const result = await service.apply(
			HOLDING,
			{ contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY, months: ['2026-05', '2026-10'], keep_remainder: true }] },
			ACTOR
		);

		expect(result.adopted[0].invoices).toEqual([
			{ invoice_id: PENDING_MAY, month: '2026-05', created: false, remainder_invoice_id: 'inv-rem' },
			{ invoice_id: 'inv-oct', month: '2026-10', created: false, remainder_invoice_id: 'inv-rem' },
		]);
		const remainders = db.statements('INSERT INTO invoices (');

		expect(remainders).toHaveLength(2);
		// [original, holding, vat, neto remanente, neto en moneda de factura, total, split_reason, nota]
		expect(remainders[0].params.slice(0, 7)).toEqual([PENDING_MAY, HOLDING, 100430.2, 528580, 528580, 629010.2, 'legacy_partial']);
		const updates = db.statements('UPDATE invoices SET status');

		expect(updates).toHaveLength(2);
		expect(updates[0].params.slice(8, 12)).toEqual([600000, 114000, 600000, 714000]);
		// El remanente se inserta antes de reescribir la original (copia su encabezado).
		expect(db.calls.findIndex((call) => call.sql.includes('INSERT INTO invoices ('))).toBeLessThan(
			db.calls.findIndex((call) => call.sql.includes('UPDATE invoices SET status'))
		);
		expect(db.statements('SELECT revenue_schedule_rebuild')).toHaveLength(1);
		expect(db.statements('SELECT revenue_schedule_rebuild')[0].params).toEqual([CONTRACT, '2026-05-01']);
	});

	it('todo o nada: un bloqueo → 409 adopt_blocked con la vista previa y sin escribir', async () => {
		const { db, service } = build();

		await expect(
			service.apply(
				HOLDING,
				{ contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }, { invoice_id: LEGACY_2, months: ['2026-04'] }] },
				ACTOR
			)
		).rejects.toMatchObject({ response: { code: 'adopt_blocked' } });
		expect(db.statements('UPDATE invoices SET status')).toHaveLength(0);
		expect(db.rolledBack()).toBe(1);
	});

	it('contrato inexistente → 404; Por Emitir que cambió durante la adopción → 409', async () => {
		const { service: missing } = build([['FOR UPDATE', () => []]]);

		await expect(missing.apply(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }] }, ACTOR)).rejects.toBeInstanceOf(
			NotFoundException
		);

		const { service: changed, db } = build([['UPDATE invoices SET status', () => []]]);

		await expect(changed.apply(HOLDING, { contract_id: CONTRACT, invoices: [{ invoice_id: LEGACY }] }, ACTOR)).rejects.toBeInstanceOf(
			ConflictException
		);
		expect(db.rolledBack()).toBe(1);
	});
});
