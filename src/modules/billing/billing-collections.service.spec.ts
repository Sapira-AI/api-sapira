jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { ContractsService } from '@/modules/contracts/contracts.service';
import type { EmailsService } from '@/modules/emails/emails.service';

import { BillingCollectionsService, DEFAULT_COLLECTION_SETTINGS } from './billing-collections.service';
import { BillingReadService } from './billing-read.service';

import type { ConfigService } from '@nestjs/config';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';
const CLIENT = 'bb0caa69-162e-4b9e-8e54-9aff347abf1f';
// 23:30 en Santiago del 01-10 = 02-10 en UTC: la fecha de negocio es el 01-10.
const NOW = new Date('2026-10-02T02:30:00Z');

/** Fila de `d` (la que devuelve `rowsByIds`). */
const row = (id: string, overrides: Record<string, unknown> = {}) => ({
	id,
	contract_id: 'k1',
	contract_number: 'CT-1',
	client_id: CLIENT,
	client_name: 'Acme',
	client_entity_name: 'Acme SpA',
	company_name: 'Sapira SpA',
	invoice_number: `F-${id.slice(0, 2)}`,
	document_type: 'FACTURA',
	document_kind: 'invoice',
	status: 'Emitida',
	issue_date: '2026-09-01',
	due_date: '2026-09-30',
	invoice_currency: 'CLP',
	total_due: '1000',
	paid_amount: '0',
	balance: '1000',
	payment_state: 'overdue',
	days_overdue: 1,
	is_active: true,
	voided: false,
	...overrides,
});

function build(
	options: { settings?: Record<string, unknown> | null; rows?: Array<Record<string, unknown>>; contacts?: Array<Record<string, unknown>> } = {}
) {
	const settings =
		options.settings === undefined
			? { ...DEFAULT_COLLECTION_SETTINGS, dunning_enabled: false, email_from: 'cobranza@acme.cl', bcc: 'finanzas@sapira.ai, otro@sapira.ai' }
			: options.settings;
	const runnerQuery = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) => {
		if (sql.includes('SELECT id, contract_id, invoice_number FROM invoices')) {
			return (options.rows ?? []).map((entry) => ({ id: entry.id, contract_id: entry.contract_id, invoice_number: entry.invoice_number }));
		}

		return [];
	});
	const runner = {
		connect: jest.fn(),
		startTransaction: jest.fn(),
		commitTransaction: jest.fn(),
		rollbackTransaction: jest.fn(),
		release: jest.fn(),
		query: runnerQuery,
	};
	const query = jest.fn(async (sql: string) => {
		if (sql.includes('FROM invoice_collection_settings')) return settings ? [settings] : [];
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'user-1' }];
		if (sql.includes('FROM client_contacts')) return options.contacts ?? [];

		return [];
	});
	const dataSource = { query, createQueryRunner: () => runner } as unknown as DataSource;
	const read = new BillingReadService(dataSource);
	const rowsByIds = jest.spyOn(read, 'rowsByIds').mockResolvedValue((options.rows ?? []) as never);
	const invoices = jest.spyOn(read, 'invoices');
	const send = jest.fn().mockResolvedValue(undefined);
	const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
	const service = new BillingCollectionsService(dataSource, read, { send } as unknown as EmailsService, {} as ContractsService, config);

	return { service, send, query, runnerQuery, rowsByIds, invoices };
}

describe('BillingCollectionsService', () => {
	it('correo de cobro: uno por cliente a sus contactos de cobranza, con la copia oculta de la configuración (B-F18: `bcc`, no `email_bcc`)', async () => {
		const { service, send, runnerQuery } = build({
			rows: [
				row('aa000000-0000-4000-8000-000000000001'),
				row('bb000000-0000-4000-8000-000000000002', { document_kind: 'credit_note', document_type: 'NC' }),
				row('cc000000-0000-4000-8000-000000000003', { status: 'Por Emitir', payment_state: 'not_applicable', balance: null }),
				row('dd000000-0000-4000-8000-000000000004', { status: 'Pagada', payment_state: 'paid', balance: '0' }),
			],
			contacts: [
				{ client_id: CLIENT, email: 'ventas@acme.cl', contact_type: 'Comercial' },
				{ client_id: CLIENT, email: 'pagos@acme.cl', contact_type: 'Facturación' },
			],
		});
		const result = await service.sendCollection(
			HOLDING,
			{
				invoice_ids: [
					'aa000000-0000-4000-8000-000000000001',
					'bb000000-0000-4000-8000-000000000002',
					'cc000000-0000-4000-8000-000000000003',
					'dd000000-0000-4000-8000-000000000004',
					'ee000000-0000-4000-8000-000000000005',
				],
				recipients_mode: 'entity_contacts',
			},
			'auth-1',
			NOW
		);

		expect(send).toHaveBeenCalledTimes(1);
		expect(send.mock.calls[0][0]).toMatchObject({
			to: ['pagos@acme.cl'],
			bcc: ['finanzas@sapira.ai', 'otro@sapira.ai'],
			from: 'cobranza@acme.cl',
		});
		expect(result.sent).toEqual([{ client_id: CLIENT, invoice_ids: ['aa000000-0000-4000-8000-000000000001'], recipients: ['pagos@acme.cl'] }]);
		expect(Object.fromEntries(result.skipped.map((entry) => [entry.invoice_id.slice(0, 2), entry.reason]))).toEqual({
			bb: 'credit_note',
			cc: 'not_issued',
			dd: 'paid',
			ee: 'not_found',
		});
		const event = runnerQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO contract_lifecycle_events'))!;

		expect(event[0]).not.toContain('CURRENT_DATE');
		// Fecha de negocio (America/Santiago), no la del servidor en UTC.
		expect(event[1]).toContain('2026-10-01');
	});

	it('vista previa del cobro: totals_by_currency con el saldo de lo que saldría, por moneda (sin sumar monedas)', async () => {
		const { service } = build({
			rows: [
				row('aa000000-0000-4000-8000-000000000001', { balance: '1000' }),
				row('bb000000-0000-4000-8000-000000000002', { balance: '250.5' }),
				row('cc000000-0000-4000-8000-000000000003', { invoice_currency: 'USD', balance: '40' }),
				row('dd000000-0000-4000-8000-000000000004', { status: 'Pagada', payment_state: 'paid', balance: '0' }),
			],
			contacts: [{ client_id: CLIENT, email: 'pagos@acme.cl', contact_type: 'Facturación' }],
		});
		const preview = await service.previewCollection(
			HOLDING,
			{
				invoice_ids: [
					'aa000000-0000-4000-8000-000000000001',
					'bb000000-0000-4000-8000-000000000002',
					'cc000000-0000-4000-8000-000000000003',
					'dd000000-0000-4000-8000-000000000004',
				],
				recipients_mode: 'entity_contacts',
			},
			NOW
		);

		expect(preview.totals_by_currency).toEqual([
			{ currency: 'CLP', amount: 1250.5, invoices: 2 },
			{ currency: 'USD', amount: 40, invoices: 1 },
		]);
	});

	it('cliente sin contactos con correo → skipped no_contacts y 409 si no queda nada que enviar', async () => {
		const { service, send } = build({ rows: [row('aa000000-0000-4000-8000-000000000001')], contacts: [] });

		await expect(
			service.sendCollection(
				HOLDING,
				{ invoice_ids: ['aa000000-0000-4000-8000-000000000001'], recipients_mode: 'entity_contacts' },
				'auth-1',
				NOW
			)
		).rejects.toMatchObject({ response: { code: 'blocked' } });
		expect(send).not.toHaveBeenCalled();
	});

	it('factura sin contrato: el correo de cobro y la proforma se rechazan con no_contract (409, como los pagos) y no se envía nada', async () => {
		const orphan = row('aa000000-0000-4000-8000-000000000001', { contract_id: null });
		const { service, send } = build({
			rows: [orphan, row('bb000000-0000-4000-8000-000000000002')],
			contacts: [{ client_id: CLIENT, email: 'pagos@acme.cl', contact_type: 'Facturación' }],
		});
		const body = {
			invoice_ids: ['aa000000-0000-4000-8000-000000000001', 'bb000000-0000-4000-8000-000000000002'],
			recipients_mode: 'entity_contacts' as const,
		};

		const preview = await service.previewCollection(HOLDING, body, NOW);

		expect(preview.can_apply).toBe(false);
		expect(preview.blockers.map((blocker) => blocker.code)).toEqual(['no_contract']);
		await expect(service.sendCollection(HOLDING, body, 'auth-1', NOW)).rejects.toMatchObject({
			response: { code: 'blocked', blockers: [expect.objectContaining({ code: 'no_contract' })] },
		});
		await expect(
			service.proforma(HOLDING, 'aa000000-0000-4000-8000-000000000001', { recipients: ['pagos@acme.cl'] }, 'auth-1', NOW)
		).rejects.toMatchObject({ response: { code: 'blocked', blockers: [expect.objectContaining({ code: 'no_contract' })] } });
		expect(send).not.toHaveBeenCalled();
	});

	it('recordatorios apagados por defecto: sin fila → defaults con dunning_enabled false y el job no lee facturas ni envía', async () => {
		const { service, send, invoices } = build({ settings: null });

		await expect(service.settings(HOLDING)).resolves.toMatchObject({ dunning_enabled: false, exists: false });
		await expect(service.runReminders(HOLDING, NOW)).resolves.toEqual({ sent: 0, skipped: 0, failed: 0 });
		expect(invoices).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
	});

	it('fila con dunning_enabled = false: el job no corre para ese holding', async () => {
		const { service, invoices } = build({ settings: { ...DEFAULT_COLLECTION_SETTINGS, dunning_enabled: false } });

		await expect(service.runReminders(HOLDING, NOW)).resolves.toEqual({ sent: 0, skipped: 0, failed: 0 });
		expect(invoices).not.toHaveBeenCalled();
	});

	it('guardar configuración: variable de plantilla desconocida → 400 con errors[{ field, message }]', async () => {
		const { service } = build();

		await expect(
			service.saveSettings(HOLDING, {
				dunning_enabled: true,
				reminder_days_before: [3],
				reminder_days_after: [7],
				email_subject_template: 'Factura {{invoice_number}}',
				email_body_template: 'Hola {{nombre}}',
			})
		).rejects.toBeInstanceOf(BadRequestException);
	});
});
