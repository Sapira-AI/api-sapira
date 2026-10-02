jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { DataSource } from 'typeorm';

import { CONTRACT_CONTEXT_SELECT, CONTRACT_INVOICE_SELECT } from '@/modules/contracts/contract-invoices.service';

import { BillingReadService } from './billing-read.service';

const HOLDING = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';
const TODAY = '2026-10-01';
const contractId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const invoiceId = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// Estado guardado del contrato: la cola no filtra por él (ni por el derivado: por renovar, vencido…).
const STATUSES = ['Activo', 'Por renovar', 'Vencido', 'Activo'];

/** Fila completa de `invoices` (lo que devolvería la BD si el SELECT pidiera todas las columnas). */
const invoiceRow = (n: number, contract: string | null) => ({
	id: invoiceId(n),
	contract_id: contract,
	invoice_number: null,
	status: 'Por Emitir',
	document_type: 'FACTURA',
	invoice_type: 'Recurrente',
	is_active: true,
	is_legacy: false,
	issue_date: null,
	scheduled_at: '2026-10-05',
	due_date: '2026-11-04',
	contract_currency: 'UF',
	invoice_currency: 'CLP',
	amount_contract_currency: '10',
	amount_invoice_currency: null,
	vat: null,
	total_invoice_currency: null,
	fx_contract_to_invoice: null,
	tax_rate: '0.19',
	lines_count: 1,
	priced_base: '10',
	client_entity_id: 'e1',
	company_id: 'co1',
});

/**
 * BD simulada: solo devuelve las columnas que el SELECT de facturas proyecta (`i.contract_id` incluida o no), y contexto para todo id
 * pedido que no esté borrado.
 */
function build(invoices: Array<Record<string, unknown>>, deleted = new Set<string>()) {
	const query = jest.fn(async (sql: string, params: unknown[]) => {
		if (sql.startsWith(CONTRACT_INVOICE_SELECT)) {
			const projectsContract = /\bi\.contract_id\b/.test(CONTRACT_INVOICE_SELECT.split('FROM invoices i')[0].split('(SELECT')[0]);
			const ids = new Set(params[1] as string[]);

			return invoices
				.filter((row) => ids.has(String(row.id)))
				.map(({ contract_id, ...rest }) => (projectsContract ? { ...rest, contract_id } : rest));
		}
		if (sql.startsWith(CONTRACT_CONTEXT_SELECT)) {
			return (params[1] as string[])
				.filter((id) => !deleted.has(id))
				.map((id) => ({
					id,
					contract_number: `CTR-${id.slice(-4)}`,
					status: STATUSES[Number(id.slice(-4)) % STATUSES.length],
					fx_invoice_policy: null,
					requires_references_for_billing: false,
					auto_send_to_odoo: true,
					payment_terms: null,
					entity_payment_terms: null,
					client_entity_id: 'e1',
					odoo_partner_id: 7,
					company_country: 'CL',
					odoo_integration_id: 1,
					cutoff_date: null,
				}));
		}

		return [];
	});

	return { service: new BillingReadService({ query } as unknown as DataSource), query };
}

describe('BillingReadService.queueEntries · contexto por contrato', () => {
	it('N facturas de M > 50 contratos: todas reciben el contexto de su contrato (ninguna queda como "sin contrato")', async () => {
		const invoices = Array.from({ length: 180 }, (_, n) => invoiceRow(n, contractId(n % 60)));
		const { service, query } = build(invoices);

		const entries = await service.queueEntries(
			HOLDING,
			invoices.map((row) => String(row.id)),
			TODAY
		);

		expect(entries).toHaveLength(180);
		expect(entries.every((entry) => entry.contract_id !== null)).toBe(true);
		expect(entries.flatMap((entry) => entry.blocked_reasons).filter((blocker) => blocker.code === 'no_contract')).toEqual([]);
		const contextCall = query.mock.calls.find(([sql]) => sql.startsWith(CONTRACT_CONTEXT_SELECT));
		expect(new Set(contextCall?.[1][1] as string[]).size).toBe(60);
	});

	it('un contrato por renovar o vencido da los mismos bloqueos que uno vigente (los de planSendNow), no "no pertenece"', async () => {
		const invoices = [invoiceRow(1, contractId(1)), invoiceRow(2, contractId(2)), invoiceRow(3, contractId(3))];
		const { service } = build(invoices);

		const [active, renewal, expired] = await service.queueEntries(
			HOLDING,
			invoices.map((row) => String(row.id)),
			TODAY
		);

		expect(renewal.blocked_reasons).toEqual(active.blocked_reasons);
		expect(expired.blocked_reasons).toEqual(active.blocked_reasons);
		expect(renewal.issue_path).toBe('erp');
	});

	it('sin contrato o con contrato borrado: bloqueo no_contract con mensaje específico', async () => {
		const invoices = [invoiceRow(1, null), invoiceRow(2, contractId(9))];
		const { service } = build(invoices, new Set([contractId(9)]));

		const [orphan, deletedContract] = await service.queueEntries(
			HOLDING,
			invoices.map((row) => String(row.id)),
			TODAY
		);

		expect(orphan.blocked_reasons.map((blocker) => blocker.message)).toEqual(['La factura no pertenece a un contrato']);
		expect(deletedContract.blocked_reasons.map((blocker) => blocker.message)).toEqual([
			'El contrato de la factura no existe en el holding o fue eliminado',
		]);
	});
});
