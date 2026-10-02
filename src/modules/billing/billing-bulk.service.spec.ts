jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ContractInvoicesService } from '@/modules/contracts/contract-invoices.service';

import { BillingBulkService } from './billing-bulk.service';

const HOLDING = '05583c6e-9364-4672-a610-0744324e44b4';
const rows = [
	{ id: 'i1', contract_id: 'k1', invoice_number: '1' },
	{ id: 'i2', contract_id: 'k2', invoice_number: '2' },
	{ id: 'i3', contract_id: 'k1', invoice_number: '3' },
	{ id: 'i4', contract_id: null, invoice_number: '4' },
];

function build(contract: Partial<Record<keyof ContractInvoicesService, jest.Mock>>) {
	const dataSource = { query: jest.fn(async () => rows) } as unknown as DataSource;

	return new BillingBulkService(dataSource, contract as unknown as ContractInvoicesService);
}

describe('BillingBulkService (fan-out por contrato)', () => {
	it('reprogramar: un reschedule-bulk por contrato con sus facturas y el mismo cuerpo; resultado por factura en el orden pedido', async () => {
		const rescheduleBulk = jest.fn<Promise<unknown>, [string, { invoice_ids: string[] }, string]>(async (_contractId, body) => ({
			updated: body.invoice_ids.filter((id) => id !== 'i3'),
			skipped: body.invoice_ids.includes('i3')
				? [{ id: 'i3', blockers: [{ code: 'period_closed', message: 'cerrado', next_step: null }] }]
				: [],
			warnings: [],
		}));
		const result = await build({ rescheduleBulk }).reschedule(
			HOLDING,
			{ invoice_ids: ['i1', 'i2', 'i3', 'i4', 'i9'], shift_months: 1, reason: 'mover' },
			'auth',
			false
		);

		expect(rescheduleBulk.mock.calls.map(([contractId, body]) => [contractId, body.invoice_ids])).toEqual([
			['k1', ['i1', 'i3']],
			['k2', ['i2']],
		]);
		expect(rescheduleBulk.mock.calls[0][1]).toMatchObject({ shift_months: 1, reason: 'mover' });
		expect(rescheduleBulk.mock.calls[0][2]).toBe(HOLDING);
		expect(result.results.map((entry) => [entry.invoice_id, entry.ok, entry.blockers[0]?.code ?? null])).toEqual([
			['i1', true, null],
			['i2', true, null],
			['i3', false, 'period_closed'],
			['i4', false, 'no_contract'],
			['i9', false, 'not_found'],
		]);
		expect(result).toMatchObject({ operation: 'reschedule', preview: false, contracts: 2, summary: { ok: 2, failed: 3 } });
	});

	it('un contrato que responde 409 no detiene a los demás; ninguna de sus facturas queda ok', async () => {
		const fxBulk = jest.fn(async (contractId: string, body: { invoice_ids: string[] }) => {
			if (contractId === 'k1') {
				throw new ConflictException({
					code: 'blocked',
					message: 'No se puede aplicar',
					blockers: [{ code: 'not_pending', message: 'no', next_step: null }],
					preview: {
						updated: [],
						skipped: body.invoice_ids.map((id) => ({ id, blockers: [{ code: 'not_pending', message: 'no', next_step: null }] })),
					},
				});
			}

			return { updated: body.invoice_ids, skipped: [], warnings: [] };
		});
		const result = await build({ fxBulk }).fx(HOLDING, { invoice_ids: ['i1', 'i2', 'i3'], policy: 'spot' }, 'auth', false);

		expect(fxBulk).toHaveBeenCalledTimes(2);
		expect(result.results.map((entry) => [entry.invoice_id, entry.ok, entry.blockers[0]?.code ?? null])).toEqual([
			['i1', false, 'not_pending'],
			['i2', true, null],
			['i3', false, 'not_pending'],
		]);
	});

	it('enviar al ERP: send-now del contrato por factura; preview usa previewSendNow; neto exacto solo con una factura', async () => {
		const sendNow = jest.fn<Promise<unknown>, [string, string]>(async () => ({ sent: true, blockers: [], warnings: [], message: 'ok' }));
		const previewSendNow = jest.fn(async () => ({ blockers: [{ code: 'needs_reference', message: 'ref', next_step: null }], warnings: [] }));
		const service = build({ sendNow, previewSendNow });
		const applied = await service.sendNow(HOLDING, { invoice_ids: ['i1', 'i2'] }, 'auth', false);
		const preview = await service.sendNow(HOLDING, { invoice_ids: ['i1'] }, 'auth', true);

		expect(sendNow.mock.calls.map((call) => [call[0], call[1]])).toEqual([
			['k1', 'i1'],
			['k2', 'i2'],
		]);
		expect(applied.summary).toEqual({ ok: 2, failed: 0 });
		expect(preview.results[0]).toMatchObject({
			ok: false,
			blockers: [expect.objectContaining({ code: 'needs_reference', action: 'references' })],
		});
		await expect(
			service.fx(HOLDING, { invoice_ids: ['i1', 'i2'], policy: 'net_exact', target_net_amount: 10 }, 'auth', false)
		).rejects.toBeInstanceOf(BadRequestException);
	});

	it('restablecer borrador: erp-reset masivo del contrato', async () => {
		const erpResetBulk = jest.fn(async (_contractId: string, body: { invoice_ids: string[] }) => ({
			updated: body.invoice_ids,
			skipped: [],
			warnings: [],
		}));
		const result = await build({ erpResetBulk }).erpReset(HOLDING, { invoice_ids: ['i2'], reason: 'borrador mal' }, 'auth');

		expect(erpResetBulk).toHaveBeenCalledWith('k2', { invoice_ids: ['i2'], reason: 'borrador mal', notes: undefined }, HOLDING, 'auth');
		expect(result.results).toEqual([expect.objectContaining({ invoice_id: 'i2', ok: true })]);
	});
});
