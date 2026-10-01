// `InvoiceSchedulerService` (dependencia de `ContractInvoicesService`) importa `uuid`, que desde la v13 es solo ESM.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { fieldErrorsOf, flattenValidationErrors } from '@/core/utils/validation-errors';
import { InvoiceSchedulerService } from '@/modules/invoices/invoice-scheduler.service';

import { API_WRITER_SQL } from './api-writer';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoicesService } from './contract-invoices.service';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { SaveDescriptionTemplateDto, UpdateInvoiceDescriptionsDto, UpdateInvoiceReferencesDto } from './dtos/contract-invoice-descriptions.dto';

type Row = Record<string, unknown>;

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';
const INV_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INV_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const HOLDING = 'h-1';
const STANDARD = 'Licencia Cuenta Norte - Periodo 01/10/2026 a 31/10/2026';

const invoiceRow = (id: string, overrides: Row = {}): Row => ({
	id,
	invoice_number: null,
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Automatica',
	is_active: true,
	is_legacy: false,
	issue_date: '2026-10-01',
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	amount_contract_currency: '1000',
	odoo_invoice_id: null,
	sent_to_odoo_at: null,
	requires_references_for_billing: false,
	consolidated_into_invoice_id: null,
	legal_name: 'Cliente SpA',
	lines_count: '1',
	lines_without_product: '0',
	priced_base: '1000',
	references_count: '0',
	...overrides,
});

const itemRow = (id: string, invoiceId: string, overrides: Row = {}): Row => ({
	id,
	invoice_id: invoiceId,
	description: STANDARD,
	description_locked: false,
	quantity: '1',
	unit_of_measure: 'UND',
	quantity_source: 'fixed',
	unit_price_contract_currency: '1000',
	subtotal_contract_currency: '1000',
	pricing_breakdown: null,
	billing_period_start: '2026-10-01',
	billing_period_end: '2026-10-31',
	product_name: 'Licencia',
	account: 'Norte',
	price_model: null,
	price_quantity_type: null,
	contract_currency: 'CLP',
	invoice_currency: 'CLP',
	fx_contract_to_invoice: '1',
	legal_name: 'Cliente SpA',
	contract_number: 'CTR-2026-001',
	references: [{ type: '801', name: 'Orden de Compra', code: '4500123' }],
	...overrides,
});

interface Fixture {
	invoices?: Record<string, Row>;
	items?: Row[];
	template?: unknown;
	maxChars?: number | null;
	references?: Row[];
}

const build = ({
	invoices = { [INV_A]: invoiceRow(INV_A) },
	items = [itemRow('l-1', INV_A)],
	template = null,
	maxChars = 80,
	references = [],
}: Fixture = {}) => {
	let events = 0;
	const route = (sql: string, params: unknown[] = []): Row[] => {
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('c.invoice_description_template, c.tax_document_type_id')) {
			return [
				{
					id: CONTRACT_ID,
					invoice_description_template: template,
					tax_document_type_id: 'tdt-33',
					own_description_max_chars: maxChars,
					company_country: 'Chile',
					document_type: 'FACTURA',
					description_limits: [],
				},
			];
		}
		if (sql.includes('priced_base')) {
			if (sql.includes("i.status = 'Por Emitir' AND i.is_active = true"))
				return Object.values(invoices).filter((row) => row.status === 'Por Emitir');
			if (sql.includes('ANY($3::uuid[])')) return (params[2] as string[]).map((id) => invoices[id]).filter(Boolean);

			return invoices[params[0] as string] ? [invoices[params[0] as string]] : [];
		}
		if (sql.includes('ii.description_locked') && sql.includes('FROM invoice_items ii')) {
			const filter = params[2];
			const ids = Array.isArray(filter) ? (filter as string[]) : [filter as string];

			return sql.includes('AND ii.id')
				? items.filter((row) => ids.includes(row.id as string))
				: items.filter((row) => ids.includes(row.invoice_id as string));
		}
		if (sql.includes('FROM invoice_references r WHERE r.invoice_id')) return references;
		if (sql.includes('INSERT INTO contract_lifecycle_events')) return [{ id: `event-${++events}` }];

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
		invoiceDetail: jest.fn().mockResolvedValue({
			id: INV_A,
			requires_references_for_billing: true,
			references: [{ id: 'r-1', kind: 'OC', type: '801', name: 'Orden de Compra', code: '4500123', date: null, source: 'invoice' }],
		}),
	} as unknown as ContractsService;
	const invoicesService = new ContractInvoicesService(dataSource, contracts, {} as InvoiceSchedulerService);

	return { service: new ContractInvoiceDescriptionsService(dataSource, contracts, invoicesService), runner, dataSource, contracts };
};
const calls = (mock: jest.Mock, needle: string) => mock.mock.calls.filter(([sql]) => (sql as string).includes(needle));
const eventMeta = (mock: jest.Mock, index = 0) => JSON.parse(calls(mock, 'INSERT INTO contract_lifecycle_events')[index][1][6] as string) as Row;
const eventType = (mock: jest.Mock, index = 0) => calls(mock, 'INSERT INTO contract_lifecycle_events')[index][1][2];
const errorsOf = async (promise: Promise<unknown>) => {
	const error = await promise.catch((caught: unknown) => caught);

	expect(error).toBeInstanceOf(BadRequestException);

	return fieldErrorsOf(error);
};

describe('ContractInvoiceDescriptionsService (spec facturas §3.6–3.7a)', () => {
	describe('plantilla del contrato', () => {
		it('GET: sin plantilla propia devuelve la estándar, el límite del documento y la muestra con la primera línea de la próxima Por Emitir', async () => {
			const { service, runner } = build();

			await expect(service.getTemplate(CONTRACT_ID, HOLDING)).resolves.toEqual({
				template: expect.objectContaining({ separator: ' - ' }),
				is_default: true,
				max_chars: 80,
				sample: {
					line_id: 'l-1',
					invoice_id: INV_A,
					text: STANDARD,
					length: STANDARD.length,
					exceeds: false,
					pending_fields: [],
					fitted: false,
					steps: [],
				},
			});
			expect(runner.query).not.toHaveBeenCalled();
		});

		it('preview: renderiza la plantilla con la línea pedida ajustada al límite (fitted + pasos); plantilla inválida → 400 por campo; línea ajena → 404', async () => {
			const { service, dataSource } = build({ maxChars: 20 });
			const preview = await service.previewTemplate(
				CONTRACT_ID,
				{
					template: {
						blocks: [{ type: 'contract_number' }, { type: 'product' }, { type: 'references' }, { type: 'period', format: 'mmm_yy' }],
					},
					line_id: 'l-1',
				},
				HOLDING
			);

			// 45 caracteres sin ajustar: el último recurso quita los bloques de datos más largos (N° de contrato, OC) y conserva el período.
			expect(preview).toEqual({
				line_id: 'l-1',
				text: 'Licencia - oct-26',
				length: 17,
				max_chars: 20,
				exceeds: false,
				pending_fields: [],
				fitted: true,
				steps: ['texto recortado'],
			});
			expect(
				await errorsOf(service.previewTemplate(CONTRACT_ID, { template: { blocks: [{ type: 'period', format: 'yyyy' }] } } as never, HOLDING))
			).toEqual([{ field: 'template.blocks.0.format', message: expect.stringContaining('range_slash') }]);
			await expect(
				service.previewTemplate(CONTRACT_ID, { template: { blocks: [{ type: 'product' }] }, line_id: 'otra' }, HOLDING)
			).rejects.toBeInstanceOf(NotFoundException);
			expect(calls(dataSource.query as unknown as jest.Mock, 'UPDATE')).toHaveLength(0);
		});

		it('PUT: una muestra que supera el límite se acepta si cabe tras el ajuste automático y lo informa (fitted, fitted_lines, description_fitted)', async () => {
			const { service, runner } = build({ maxChars: 30 });
			const template = { blocks: [{ type: 'product' as const }, { type: 'period' as const }] };
			// Sin ajustar: "Licencia - 01/10/2026 a 31/10/2026" (34) > 30 → período corto (range_dash 31 → month_year 23).
			const result = await service.saveTemplate(CONTRACT_ID, { template, apply_to_pending: true }, HOLDING, 'auth-1');

			expect(result).toMatchObject({
				template,
				updated_lines: 1,
				fitted_lines: 1,
				sample: { text: 'Licencia - octubre 2026', length: 23, fitted: true, steps: ['período corto'] },
				warning_codes: ['description_fitted'],
			});
			expect(result.warnings).toEqual([
				'La descripción de muestra se ajustó automáticamente: período corto',
				'1 línea se ajustó automáticamente al límite de 30 caracteres',
			]);
			expect(calls(runner.query, 'UPDATE invoice_items ii SET description').map(([, params]) => params)).toEqual([
				['l-1', HOLDING, 'Licencia - octubre 2026', false],
			]);
			expect(eventMeta(runner.query)).toMatchObject({ fitted_lines: 1 });
			expect(runner.commitTransaction).toHaveBeenCalled();
		});

		it('apply_template: las líneas regeneradas se ajustan al límite y la vista previa marca fitted por línea', async () => {
			const { service } = build({ maxChars: 40 });
			const preview = await service.previewDescriptions(CONTRACT_ID, { invoice_ids: [INV_A], mode: 'apply_template' }, HOLDING);

			expect(preview.lines).toEqual([
				expect.objectContaining({
					line_id: 'l-1',
					after: 'Licencia Cuenta Norte - Periodo oct-26',
					exceeds: false,
					fitted: true,
					fit_steps: ['período corto'],
				}),
			]);
			expect(preview.warning_codes).toEqual(['description_fitted']);
		});

		it('PUT con apply_to_pending: marca api primero, guarda la plantilla, regenera solo líneas no protegidas de Por Emitir sin ERP y deja un evento', async () => {
			const { service, runner } = build({
				invoices: { [INV_A]: invoiceRow(INV_A), [INV_B]: invoiceRow(INV_B, { odoo_invoice_id: 77 }) },
				items: [
					itemRow('l-1', INV_A),
					itemRow('l-2', INV_A, { description: 'Texto a mano', description_locked: true }),
					itemRow('l-3', INV_B),
				],
			});
			const template = { blocks: [{ type: 'product' as const }, { type: 'period' as const, format: 'month_year' }] };
			const result = await service.saveTemplate(CONTRACT_ID, { template, apply_to_pending: true }, HOLDING, 'auth-1');

			expect(result).toEqual({
				template,
				is_default: false,
				updated_lines: 1,
				skipped_locked: 1,
				skipped_manual: 0,
				fitted_lines: 0,
				sample: { text: 'Licencia - octubre 2026', length: 23, fitted: false, steps: [] },
				warnings: [],
				warning_codes: [],
			});
			expect(runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);
			expect(calls(runner.query, 'UPDATE contracts SET invoice_description_template')[0][1]).toEqual([
				CONTRACT_ID,
				HOLDING,
				JSON.stringify(template),
			]);
			const updates = calls(runner.query, 'UPDATE invoice_items ii SET description');

			expect(updates.map(([, params]) => params)).toEqual([['l-1', HOLDING, 'Licencia - octubre 2026', false]]);
			expect(updates[0][0]).toContain("i.status = 'Por Emitir'");
			expect(eventType(runner.query)).toBe('CONTRACT_DESCRIPTION_TEMPLATE_CHANGED');
			expect(eventMeta(runner.query)).toMatchObject({
				source: 'contract_360',
				before: null,
				after: template,
				apply_to_pending: true,
				updated_lines: 1,
				skipped_locked: 1,
				invoice_ids: [INV_A],
				lines: [{ line_id: 'l-1', invoice_id: INV_A, before: STANDARD, after: 'Licencia - octubre 2026' }],
			});
		});

		it('PUT null vuelve a la estándar (is_default) y guarda NULL', async () => {
			const { service, runner } = build({ template: { blocks: [{ type: 'product' }] } });
			const result = await service.saveTemplate(CONTRACT_ID, { template: null }, HOLDING, 'auth-1');

			expect(result).toMatchObject({ is_default: true, updated_lines: 0, skipped_locked: 0 });
			expect(calls(runner.query, 'UPDATE contracts SET invoice_description_template')[0][1]).toEqual([CONTRACT_ID, HOLDING, null]);
			expect(eventMeta(runner.query)).toMatchObject({ before: { blocks: [{ type: 'product' }] }, after: null });
		});
	});

	describe('descripciones de líneas (selección)', () => {
		it('preview: antes/después por línea; las de facturas bloqueadas y las protegidas se informan con su motivo; no escribe', async () => {
			const { service, dataSource } = build({
				invoices: { [INV_A]: invoiceRow(INV_A), [INV_B]: invoiceRow(INV_B, { status: 'Emitida' }) },
				items: [itemRow('l-1', INV_A, { description: 'viejo' }), itemRow('l-2', INV_A, { description_locked: true }), itemRow('l-3', INV_B)],
			});
			const preview = await service.previewDescriptions(CONTRACT_ID, { invoice_ids: [INV_A, INV_B], mode: 'apply_template' }, HOLDING);

			expect(preview.max_chars).toBe(80);
			expect(preview.lines.map((line) => [line.line_id, line.after, line.skipped_reason ?? null])).toEqual([
				['l-1', STANDARD, null],
				['l-2', STANDARD, 'locked'],
				['l-3', STANDARD, 'not_pending'],
			]);
			expect((dataSource as unknown as { createQueryRunner: jest.Mock }).createQueryRunner).not.toHaveBeenCalled();
		});

		it('set: texto manual protege la línea (description_locked) y deja un evento por factura con antes/después', async () => {
			const { service, runner } = build({ items: [itemRow('l-1', INV_A), itemRow('l-2', INV_A)] });
			const result = await service.updateDescriptions(
				CONTRACT_ID,
				{ line_ids: ['l-2'], mode: 'set', text: 'Servicio septiembre — OC 45' },
				HOLDING,
				'auth-1'
			);

			expect(result).toEqual({ updated: 1, skipped: [], event_ids: ['event-1'], fitted: [], warning_codes: [] });
			expect(runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);
			expect(calls(runner.query, 'UPDATE invoice_items ii SET description').map(([, params]) => params)).toEqual([
				['l-2', HOLDING, 'Servicio septiembre - OC 45', true],
			]);
			expect(eventType(runner.query)).toBe('INVOICE_DESCRIPTIONS_UPDATED');
			expect(eventMeta(runner.query)).toMatchObject({
				invoice_id: INV_A,
				mode: 'set',
				lines: [{ line_id: 'l-2', before: STANDARD, after: 'Servicio septiembre - OC 45', locked_before: false, locked_after: true }],
			});
		});

		it('set que supera el límite → 400 (field text) sin escribir; unlock libera y regenera', async () => {
			const { service, runner } = build({ items: [itemRow('l-1', INV_A, { description: 'a mano', description_locked: true })] });

			expect(
				await errorsOf(service.updateDescriptions(CONTRACT_ID, { line_ids: ['l-1'], mode: 'set', text: 'x'.repeat(81) }, HOLDING, 'auth-1'))
			).toEqual([{ field: 'text', message: expect.stringContaining('81 caracteres') }]);
			expect(calls(runner.query, 'UPDATE invoice_items')).toHaveLength(0);

			const unlocked = await service.updateDescriptions(CONTRACT_ID, { line_ids: ['l-1'], mode: 'unlock' }, HOLDING, 'auth-1');

			expect(unlocked.updated).toBe(1);
			expect(calls(runner.query, 'UPDATE invoice_items ii SET description').map(([, params]) => params)).toEqual([
				['l-1', HOLDING, STANDARD, false],
			]);
		});

		it('sin facturas ni líneas → 400; apply_blocks sin plantilla → 400; línea de otro contrato → 404', async () => {
			const { service } = build();

			expect(await errorsOf(service.previewDescriptions(CONTRACT_ID, { mode: 'apply_template' }, HOLDING))).toEqual([
				{ field: 'invoice_ids', message: 'Indica las facturas o las líneas' },
			]);
			expect(await errorsOf(service.previewDescriptions(CONTRACT_ID, { invoice_ids: [INV_A], mode: 'apply_blocks' }, HOLDING))).toEqual([
				{ field: 'template', message: 'Indica la plantilla a aplicar' },
			]);
			await expect(service.previewDescriptions(CONTRACT_ID, { line_ids: ['ajena'], mode: 'unlock' }, HOLDING)).rejects.toBeInstanceOf(
				NotFoundException
			);
		});
	});

	describe('referencias OC/HES (PUT …/references)', () => {
		it('reemplaza las referencias propias con el mapeo del detalle, actualiza requires_references_for_billing y deja el evento', async () => {
			const { service, runner } = build({
				references: [
					{
						document_type_code: '801',
						document_type_name: 'Orden de Compra',
						document_number: '1',
						reference_date: null,
						reference_code: null,
						reason: null,
					},
				],
			});
			const result = await service.updateReferences(
				CONTRACT_ID,
				INV_A,
				{
					references: [
						{ type: 'OC', code: '4500123', date: '2026-09-15' },
						{ type: 'HES', code: '998' },
					],
					requires_references_for_billing: true,
				},
				HOLDING,
				'auth-1'
			);

			expect(result).toEqual({
				invoice_id: INV_A,
				requires_references_for_billing: true,
				references: [expect.objectContaining({ kind: 'OC', code: '4500123' })],
				warnings: [],
			});
			expect(runner.query.mock.calls[0][0]).toBe(API_WRITER_SQL);
			expect(calls(runner.query, 'DELETE FROM invoice_references')[0][1]).toEqual([INV_A, HOLDING]);
			expect(calls(runner.query, 'INSERT INTO invoice_references').map(([, params]) => params)).toEqual([
				[INV_A, HOLDING, '4500123', '801', 'Orden de Compra', null, null, '2026-09-15', 'auth-1'],
				[INV_A, HOLDING, '998', 'HES', 'Hoja de Entrada de Servicio', null, null, null, 'auth-1'],
			]);
			expect(calls(runner.query, 'UPDATE invoices SET requires_references_for_billing')[0][1]).toEqual([INV_A, HOLDING, true]);
			expect(eventType(runner.query)).toBe('INVOICE_REFERENCES_UPDATED');
			expect(eventMeta(runner.query)).toMatchObject({
				invoice_id: INV_A,
				before: { references: [{ document_number: '1' }], requires_references_for_billing: false },
				after: { references: [{ document_number: '4500123' }, { document_number: '998' }], requires_references_for_billing: true },
			});
		});

		it('emitida ya enviada al ERP → 409 blocked sin escribir; repetidas → 400 por índice', async () => {
			const sent = build({ invoices: { [INV_A]: invoiceRow(INV_A, { status: 'Emitida', odoo_invoice_id: 9 }) } });
			const error = await sent.service
				.updateReferences(CONTRACT_ID, INV_A, { references: [{ type: 'OC', code: '1' }] }, HOLDING, 'auth-1')
				.catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(ConflictException);
			expect((error as ConflictException).getResponse()).toMatchObject({
				code: 'blocked',
				blockers: [expect.objectContaining({ code: 'sent_to_erp' })],
			});
			expect(calls(sent.runner.query, 'DELETE')).toHaveLength(0);

			const { service } = build();

			expect(
				await errorsOf(
					service.updateReferences(
						CONTRACT_ID,
						INV_A,
						{
							references: [
								{ type: 'OC', code: '1' },
								{ type: 'OC', code: '1' },
							],
						},
						HOLDING,
						'auth-1'
					)
				)
			).toEqual([{ field: 'references.1.code', message: 'Referencia repetida en la factura' }]);
		});
	});

	describe('DTOs (whitelist)', () => {
		const check = async <T extends object>(cls: new () => T, body: unknown) =>
			flattenValidationErrors(await validate(plainToInstance(cls, body) as object, { whitelist: true, forbidNonWhitelisted: true }));

		it('plantilla null es válida; bloques y referencias se validan anidados y sin campos desconocidos', async () => {
			expect(await check(SaveDescriptionTemplateDto, { template: null, apply_to_pending: true })).toEqual([]);
			expect(await check(SaveDescriptionTemplateDto, { template: { blocks: [{ type: 'product', color: 'red' }] } })).toEqual([
				{ field: 'template.blocks.0.color', message: expect.any(String) },
			]);
			expect((await check(SaveDescriptionTemplateDto, { template: { blocks: [{ type: 'otro' }] } }))[0].field).toBe('template.blocks.0.type');
			expect(await check(UpdateInvoiceDescriptionsDto, { line_ids: ['11111111-1111-4111-8111-111111111111'], mode: 'set' })).toEqual([
				{ field: 'text', message: expect.any(String) },
			]);
			expect(await check(UpdateInvoiceReferencesDto, { references: [{ type: 'OTHER', code: '7' }] })).toEqual([
				{ field: 'references.0.document_type_code', message: expect.any(String) },
			]);
			expect(await check(UpdateInvoiceReferencesDto, { references: [{ type: 'OC', code: '7', date: '2026-13-01' }] })).toEqual([
				{ field: 'references.0.date', message: 'La fecha debe tener la forma YYYY-MM-DD' },
			]);
		});
	});

	describe('rutas del controlador', () => {
		const route = (name: keyof ContractsController) => [
			Reflect.getMetadata(METHOD_METADATA, ContractsController.prototype[name]),
			Reflect.getMetadata(PATH_METADATA, ContractsController.prototype[name]),
		];

		it('expone GET/PUT de la plantilla, sus vistas previas, PATCH de descripciones y PUT de referencias', () => {
			expect(route('descriptionTemplate')).toEqual([0, ':id/invoice-description-template']);
			expect(route('descriptionTemplatePreview')).toEqual([1, ':id/invoice-description-template/preview']);
			expect(route('saveDescriptionTemplate')).toEqual([2, ':id/invoice-description-template']);
			expect(route('descriptionsPreview')).toEqual([1, ':id/invoices/descriptions/preview']);
			expect(route('updateDescriptions')).toEqual([4, ':id/invoices/descriptions']);
			expect(route('updateReferences')).toEqual([2, ':id/invoices/:invoiceId/references']);
		});
	});
});

describe('ContractInvoiceDescriptionsService.regenerateLines (item_update, spec modificaciones §9.2)', () => {
	it('regenera con la plantilla y la cuenta nueva solo las líneas no protegidas; la escrita a mano queda igual', async () => {
		const { service, runner } = build({
			items: [
				itemRow('l-1', INV_A, { account: 'Sur', description: STANDARD }),
				itemRow('l-2', INV_A, { account: 'Sur', description: 'Texto a mano', description_locked: true }),
			],
		});
		const applied = await service.regenerateLines(runner as never, CONTRACT_ID, HOLDING, ['l-1', 'l-2']);

		expect(applied.map((plan) => [plan.line_id, plan.after])).toEqual([['l-1', 'Licencia Cuenta Sur - Periodo 01/10/2026 a 31/10/2026']]);
		expect(calls(runner.query, 'UPDATE invoice_items ii SET description').map(([, params]) => params)).toEqual([
			['l-1', HOLDING, 'Licencia Cuenta Sur - Periodo 01/10/2026 a 31/10/2026', false],
		]);
	});

	it('sin líneas no consulta nada', async () => {
		const { service, runner } = build();

		await expect(service.regenerateLines(runner as never, CONTRACT_ID, HOLDING, [])).resolves.toEqual([]);
		expect(runner.query).not.toHaveBeenCalled();
	});
});
