import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { HoldingMetricsService } from '@/modules/metrics/holding-metrics.service';

import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractDraftsService } from './contract-drafts.service';
import { deriveContractStatus, type StatusItem } from './contract-status';
import { ContractSubscriptionsService, parseSubscriptionStatus } from './contract-subscriptions.service';
import { ContractsController } from './contracts.controller';
import { ContractsService, parseStatusFilter } from './contracts.service';
import { QueryContractSubscriptionsDto } from './dtos/query-contract-subscriptions.dto';
import { QueryContractsDto } from './dtos/query-contracts.dto';

const CONTRACT_ID = '11111111-1111-4111-8111-111111111111';

describe('ContractsService', () => {
	const build = (impl: (sql: string, params: unknown[]) => unknown[] = () => [{}]) => {
		const query = jest.fn(async (sql: string, params: unknown[]) => impl(sql, params));
		const metrics = {
			monthMetrics: jest.fn().mockResolvedValue({
				currency: 'USD',
				mrr: { value: 1000, previous: 900, trend: 11.1 },
				activeClients: { value: 5, previous: 5, trend: 0 },
			}),
			systemCurrency: jest.fn().mockResolvedValue('USD'),
		} as unknown as HoldingMetricsService;

		return { service: new ContractsService({ query } as unknown as DataSource, metrics), query, metrics };
	};
	const asOf = new Date('2026-09-25T12:00:00.000Z');
	const listCall = (query: jest.Mock) => query.mock.calls.find(([sql]) => (sql as string).includes('LIMIT '))!;
	const countCall = (query: jest.Mock) => query.mock.calls.find(([sql]) => (sql as string).includes('AS all_count'))!;
	const ACTIVE_FILTER = `AND ds.derived_status IN ('active')`;

	describe('list', () => {
		it('acota al holding y aplica todos los filtros, compartidos con el conteo', async () => {
			const { service, query } = build((sql) =>
				sql.includes('all_count') ? [{ all_count: '9', active_count: '4', pending_renewal_count: '2' }] : []
			);

			const result = await service.list(
				'h-1',
				{
					status: 'active',
					search: ' acme ',
					clientId: 'cl-1',
					entityId: 'none',
					companyId: 'co-1',
					currency: 'usd',
					productId: 'p-1',
					endingWithinDays: 30,
					page: 2,
					limit: 10,
				},
				asOf
			);

			const [listSql, listParams] = listCall(query);
			const [countSql, countParams] = countCall(query);

			expect(listParams).toEqual(['h-1', '2026-09-25', 'cl-1', ['co-1'], ['USD'], ['p-1'], '%acme%', 30]);
			expect(countParams).toBe(listParams);
			for (const sql of [listSql, countSql] as string[]) {
				expect(sql).toContain('c.holding_id = $1');
				expect(sql).toContain('c.client_id = $3');
				expect(sql).toContain('c.client_entity_id IS NULL');
				expect(sql).toContain('c.company_id = ANY($4::uuid[])');
				expect(sql).toContain('c.contract_currency = ANY($5::text[])');
				expect(sql).toContain('pi.product_id = ANY($6::uuid[])');
				expect(sql).toContain('ce.legal_name ILIKE $7');
				expect(sql).toContain('$2::date + $8::int');
				expect(sql).toContain(`ds.derived_status IN ('active', 'pending_renewal') AND nx.next_item_end_date`);
				expect(sql).toContain(') ds ON true');
			}
			// El estado filtra la lista, no el conteo.
			expect(listSql).toContain(ACTIVE_FILTER);
			expect(countSql).not.toContain(ACTIVE_FILTER);
			expect(listSql).toContain('LIMIT 10 OFFSET 10');
			expect(listSql).toContain(`r.momentum IS DISTINCT FROM 'PENDING_RENEWAL'`);
			expect(result).toMatchObject({
				items: 4,
				pages: 1,
				currentPage: 2,
				limit: 10,
				counts: { all: 9, active: 4, pending_renewal: 2, expired: 0, draft: 0, paused: 0, cancelled: 0 },
			});
		});

		it('acepta varios estados (in_review = draft) y el total suma sus conteos', async () => {
			const { service, query } = build((sql) =>
				sql.includes('all_count') ? [{ all_count: '20', pending_renewal_count: '3', expired_count: '5', draft_count: '2' }] : []
			);

			const result = await service.list('h-1', { status: 'pending_renewal,expired,in_review' }, asOf);

			expect(listCall(query)[0]).toContain(`AND ds.derived_status IN ('pending_renewal', 'expired', 'draft')`);
			expect(listCall(query)[1]).toEqual(['h-1', '2026-09-25']);
			expect(result.items).toBe(10);
		});

		it('aplica los filtros avanzados en lista y conteo', async () => {
			const { service, query } = build(() => []);

			await service.list(
				'h-1',
				{
					type: 'Nuevo cliente,Histórico',
					minValue: 100,
					maxValue: 5000,
					startFrom: '2026-01-01',
					startTo: '2026-06-30',
					endFrom: '2026-07-01',
					endTo: '2027-12-31',
					nextEndFrom: '2026-10-01',
					nextEndTo: '2026-10-31',
					multicompany: 'true',
					multicurrency: 'false',
					clientCountry: 'Chile,Perú',
					entityCountry: 'CL',
					autoInvoice: 'false',
					hasErpInvoice: 'true',
					sellerId: '22222222-2222-4222-8222-222222222222',
				},
				asOf
			);
			const [listSql, params] = listCall(query);

			expect(params).toEqual([
				'h-1',
				'2026-09-25',
				['Nuevo cliente', 'Histórico'],
				100,
				5000,
				'2026-01-01',
				'2026-06-30',
				'2026-07-01',
				'2027-12-31',
				'2026-10-01',
				'2026-10-31',
				['Chile', 'Perú'],
				['CL'],
				['22222222-2222-4222-8222-222222222222'],
			]);
			for (const sql of [listSql, countCall(query)[0]] as string[]) {
				expect(sql).toContain('c.type = ANY($3::text[])');
				expect(sql).toContain('c.total_value_system_currency >= $4::numeric');
				expect(sql).toContain('c.total_value_system_currency <= $5::numeric');
				expect(sql).toContain('items.start_date >= $6::date');
				expect(sql).toContain('items.start_date <= $7::date');
				expect(sql).toContain('c.contract_end_date >= $8::date');
				expect(sql).toContain('c.contract_end_date <= $9::date');
				expect(sql).toContain('nx.next_item_end_date >= $10::date');
				expect(sql).toContain('nx.next_item_end_date <= $11::date');
				expect(sql).toContain('c.requires_multicompany_billing IS TRUE');
				expect(sql).toContain('c.requires_multicurrency_billing IS NOT TRUE');
				expect(sql).toContain('cl.country = ANY($12::text[])');
				expect(sql).toContain('ce.country = ANY($13::text[])');
				expect(sql).toContain('c.auto_invoice IS NOT TRUE');
				expect(sql).toMatch(
					/ EXISTS \(SELECT 1 FROM invoices ei WHERE ei.contract_id = c.id AND ei.holding_id = \$1 AND ei.odoo_invoice_id IS NOT NULL\)/
				);
				expect(sql).toContain('qt.seller_id = ANY($14::uuid[])');
			}

			query.mockClear();
			await service.list('h-1', { hasErpInvoice: 'false' }, asOf);
			expect(listCall(query)[0]).toContain('NOT EXISTS (SELECT 1 FROM invoices ei');
		});

		it('excluye los borradores eliminados y filtra por envío automático a Odoo (NULL cuenta como sí)', async () => {
			const { service, query } = build(() => []);

			await service.list('h-1', { autoSendToOdoo: 'true' }, asOf);
			expect(listCall(query)[0]).toContain("(to_jsonb(c)->>'deleted_at') IS NULL");
			expect(countCall(query)[0]).toContain("(to_jsonb(c)->>'deleted_at') IS NULL");
			expect(listCall(query)[0]).toContain('c.auto_send_to_odoo IS DISTINCT FROM false');

			query.mockClear();
			await service.list('h-1', { autoSendToOdoo: 'false' }, asOf);
			expect(listCall(query)[0]).toContain('c.auto_send_to_odoo = false');
		});

		it('ordena solo por columnas de la lista blanca', async () => {
			const { service, query } = build(() => []);

			await service.list('h-1', { sortBy: 'next_item_end_date', sortOrder: 'asc' }, asOf);
			expect(listCall(query)[0]).toContain('ORDER BY nx.next_item_end_date ASC NULLS LAST, c.id');

			query.mockClear();
			await service.list('h-1', { sortBy: 'status' }, asOf);
			expect(listCall(query)[0]).toContain('ORDER BY ds.derived_status DESC NULLS LAST, c.id');

			query.mockClear();
			await service.list('h-1', { sortBy: 'client_name; DROP TABLE contracts' as never }, asOf);
			expect(listCall(query)[0]).toContain('ORDER BY items.start_date DESC NULLS LAST, c.id');
			expect(listCall(query)[0]).not.toContain('DROP TABLE');
		});

		it('mapea la fila al contrato de la lista', async () => {
			const { service } = build((sql) =>
				sql.includes('all_count')
					? [{ all_count: '1' }]
					: [
							{
								id: 'k-1',
								contract_number: 'CTR-1',
								status: 'Activo',
								derived_status: 'pending_renewal',
								type: '',
								seller_id: 's-1',
								seller_name: 'Ana',
								auto_invoice: null,
								mrr: '12.5',
								items_count: '3',
								days_to_end: '10',
								days_since_end: null,
								products: ['A', 'B'],
								auto_send_to_odoo: true,
								next_item_end_date: '2026-10-05',
							},
						]
			);

			const { data } = await service.list('h-1', {}, asOf);

			expect(data[0]).toMatchObject({
				id: 'k-1',
				type: null,
				mrr: 12.5,
				items_count: 3,
				days_to_end: 10,
				days_since_end: null,
				products: ['A', 'B'],
				auto_send_to_odoo: true,
				next_item_end_date: '2026-10-05',
				derived_status: 'pending_renewal',
				seller: { id: 's-1', name: 'Ana' },
				auto_invoice: null,
			});
		});
		it('busca también por RUT sin puntos ni guion, número de cotización y nombre de cualquier ítem', async () => {
			const { service, query } = build(() => []);

			await service.list('h-1', { search: '76.123.456-7' }, asOf);
			const [listSql, listParams] = listCall(query);
			const [countSql] = countCall(query);

			expect(listParams).toEqual(['h-1', '2026-09-25', '%76.123.456-7%']);
			for (const sql of [listSql, countSql] as string[]) {
				expect(sql).toContain('c.contract_number ILIKE $3');
				expect(sql).toContain('cl.name_commercial ILIKE $3');
				expect(sql).toContain('ce.legal_name ILIKE $3');
				expect(sql).toContain('qt.quote_number ILIKE $3');
				expect(sql).toContain("regexp_replace(ce.tax_id, '[.[:space:]-]', '', 'g') ILIKE regexp_replace($3, '[.[:space:]-]', '', 'g')");
				// Un texto de solo signos no compara el RUT (quedaría `%%` y encontraría todo).
				expect(sql).toContain("regexp_replace($3, '[.[:space:]-]', '', 'g') <> '%%'");
				expect(sql).toContain('EXISTS (SELECT 1 FROM contract_items si WHERE si.contract_id = c.id AND si.product_name ILIKE $3)');
			}
		});

		it('totales sobre todo el conjunto filtrado (estado incluido), con el mismo MRR de las filas y la moneda del sistema', async () => {
			const { service, query, metrics } = build((sql) =>
				sql.includes('contracts_count')
					? [{ contracts_count: '42', mrr_total: '1234.567', total_value_system: '99000.004' }]
					: sql.includes('all_count')
						? [{ all_count: '50', active_count: '42' }]
						: []
			);

			const result = await service.list('h-1', { status: 'active', search: 'acme', page: 3, limit: 10 }, asOf);
			const [totalsSql, totalsParams] = query.mock.calls.find(([sql]) => (sql as string).includes('contracts_count'))!;

			expect(totalsParams).toBe(listCall(query)[1]);
			expect(totalsSql).toContain(ACTIVE_FILTER);
			expect(totalsSql).toContain('qt.quote_number ILIKE $3');
			expect(totalsSql).not.toContain('LIMIT');
			expect(totalsSql).toContain(`r.momentum IS DISTINCT FROM 'PENDING_RENEWAL'`);
			expect(totalsSql).toContain('SUM(c.total_value_system_currency)');
			expect(metrics.systemCurrency).toHaveBeenCalledWith('h-1');
			expect(result.totals).toEqual({ contracts: 42, mrr: 1234.57, total_value_system: 99000, currency: 'USD' });
		});

		it('sin filas, los totales van en cero', async () => {
			const { service } = build(() => []);

			expect((await service.list('h-1', {}, asOf)).totals).toEqual({ contracts: 0, mrr: 0, total_value_system: 0, currency: 'USD' });
		});
	});

	describe('summary', () => {
		it('resta el pendiente de renovar al MRR del Dashboard y lo expone aparte', async () => {
			const { service } = build((sql) => {
				if (sql.includes(`momentum = 'PENDING_RENEWAL'`)) return [{ pending: '150.25' }];

				return [{ active_count: '7', pending_renewal_count: '4', ending_30d: '2', expired_count: '3', draft_count: '1', paused_count: '0' }];
			});

			await expect(service.summary('h-1', asOf)).resolves.toEqual({
				as_of: '2026-09-25',
				currency: 'USD',
				mrr: 849.75,
				pending_renewal_mrr: 150.25,
				active_contracts: 7,
				pending_renewal: 4,
				expired: 3,
				draft: 1,
				paused: 0,
				ending_30d: 2,
			});
		});

		it('cuenta con el mismo estado mostrado que la lista (mismo lateral y misma regla de por vencer)', async () => {
			const { service, query } = build(() => [{}]);

			await service.summary('h-1', asOf);
			const [sql] = query.mock.calls.find(([text]) => (text as string).includes('pending_renewal_count'))!;
			const [listSql] = await (async () => {
				const list = build(() => []);

				await list.service.list('h-1', { endingWithinDays: 30 }, asOf);

				return listCall(list.query);
			})();
			const lateral = (text: string) => text.slice(text.indexOf('LEFT JOIN LATERAL (\n\tSELECT CASE'), text.indexOf(') ds ON true'));

			expect(lateral(sql as string)).toBe(lateral(listSql as string));
			expect(sql).toMatch(
				/ds\.derived_status IN \('active', 'pending_renewal'\)\s+AND nx\.next_item_end_date BETWEEN \$2::date AND \$2::date \+ 30/
			);
		});
	});

	describe('filterOptions', () => {
		it('devuelve tipos, países, vendedores y lo existente, acotado al holding', async () => {
			const { service, query } = build((sql) => {
				if (sql.includes('FROM contracts c JOIN companies')) return [{ id: 'co-1', name: 'Acme SpA' }];
				if (sql.includes('FROM contract_items ci')) return [{ id: 'p-1', name: 'Licencia' }];
				if (sql.includes('JOIN sellers')) return [{ id: 's-1', name: 'Ana' }];
				if (sql.includes('c.contract_currency AS value')) return [{ value: 'USD' }];
				if (sql.includes('c.type AS value')) return [{ value: 'Histórico' }];
				if (sql.includes('cl.country AS value')) return [{ value: 'Chile' }];
				if (sql.includes('ce.country AS value')) return [{ value: 'CL' }];

				return [];
			});

			await expect(service.filterOptions('h-1')).resolves.toEqual({
				companies: [{ id: 'co-1', name: 'Acme SpA' }],
				currencies: ['USD'],
				products: [{ id: 'p-1', name: 'Licencia' }],
				types: ['Histórico'],
				client_countries: ['Chile'],
				entity_countries: ['CL'],
				sellers: [{ id: 's-1', name: 'Ana' }],
				segments: [],
				markets: [],
				industries: [],
			});
			for (const [sql, params] of query.mock.calls) {
				expect(params).toEqual(['h-1']);
				expect(sql).toContain('c.holding_id = $1');
				expect(sql).toContain("(to_jsonb(c)->>'deleted_at') IS NULL");
			}
		});
	});

	describe('rutas por contrato', () => {
		const notInHolding = (sql: string) => (sql.includes('LIMIT 1') ? [] : [{}]);

		it.each(['detail', 'items', 'history', 'revenue'] as const)('%s responde 404 si el contrato no es del holding', async (method) => {
			const { service, query } = build(notInHolding);

			await expect(service[method](CONTRACT_ID, 'h-otro')).rejects.toBeInstanceOf(NotFoundException);
			expect(query).toHaveBeenCalledTimes(1);
			expect(query.mock.calls[0][1]).toEqual([CONTRACT_ID, 'h-otro']);
			expect(query.mock.calls[0][0]).toContain('c.holding_id = $2');
		});

		it('invoices responde 404 si el contrato no es del holding', async () => {
			const { service } = build(notInHolding);

			await expect(service.invoices(CONTRACT_ID, 'h-otro', {})).rejects.toBeInstanceOf(NotFoundException);
		});

		it('busca por número de contrato si el id no es un UUID', async () => {
			const { service, query } = build(notInHolding);

			await expect(service.detail('CTR-2026-184', 'h-1')).rejects.toBeInstanceOf(NotFoundException);
			expect(query.mock.calls[0][0]).toContain('c.contract_number = $1');
		});

		it('ítems: deriva estado, arma el ítem madre y cruza con las Por Emitir', async () => {
			const { service } = build((sql) => {
				if (sql.includes('LIMIT 1')) return [{ id: CONTRACT_ID, status: 'Activo' }];
				if (sql.includes('FROM contract_items ci'))
					return [
						{
							id: 'a',
							product_name: 'LIC',
							quantity: '5',
							monthly_price: '50',
							billing_period_price: '50',
							is_recurring: true,
							start_date: '2026-01-01',
							end_date: '2026-12-31',
							categoria: 'NEW',
						},
						{
							id: 'b',
							product_name: 'LIC',
							quantity: '1',
							monthly_price: '10',
							billing_period_price: '10',
							is_recurring: true,
							start_date: '2026-11-01',
							end_date: '2026-12-31',
							categoria: 'UPSELL',
						},
					];

				return [{ invoice_id: 'pe-1', issue_date: '2026-10-01', contract_item_id: 'a', subtotal: '50' }];
			});

			const result = await service.items(CONTRACT_ID, 'h-1', asOf);

			expect(result.items.map((item) => item.status)).toEqual(['active', 'future']);
			expect(result.groups).toHaveLength(1);
			expect(result.groups[0]).toMatchObject({ quantity: 5, mrr: 50, next_invoice: { id: 'pe-1', amount: 50, matches: true } });
		});

		it('facturas: filtra por estado sin parámetros sueltos y cuenta por estado', async () => {
			const { service, query } = build((sql) => {
				if (sql.includes('LIMIT 1')) return [{ id: CONTRACT_ID }];
				if (sql.includes('all_count')) return [{ all_count: '5', pending_count: '2', issued_count: '2', cancelled_count: '1' }];

				return [];
			});

			const result = await service.invoices(CONTRACT_ID, 'h-1', { status: 'issued', sortBy: 'amount', sortOrder: 'desc' });
			const [sql, params] = query.mock.calls.find(([text]) => (text as string).includes('OFFSET'))!;

			expect(params).toEqual([CONTRACT_ID, 'h-1']);
			expect(sql).toContain(`i.status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada')`);
			expect(sql).toContain('ORDER BY i.amount_contract_currency DESC');
			expect(result).toMatchObject({ items: 2, counts: { all: 5, pending: 2, issued: 2, cancelled: 1 } });
		});
	});

	describe('buildAlerts', () => {
		it('arma las alertas en lenguaje natural', () => {
			const alerts = ContractsService.buildAlerts({
				status: 'Activo',
				contract_currency: 'USD',
				total_value: '1200',
				items_count: '2',
				items_total: '1000',
				items_without_product: '1',
				invoices_count: '3',
				invoiced_total: '1100',
				header_vs_lines: '2',
				fixed_fx_without_rate: '1',
				auto_send_to_odoo: true,
				client_entity_id: 'e-1',
				odoo_partner_id: null,
				expired_items: '1',
			});

			expect(alerts.map((alert) => [alert.code, alert.severity])).toEqual([
				['fixed_fx_without_rate', 'error'],
				['items_without_product', 'warning'],
				['balance', 'warning'],
				['invoices_vs_total', 'info'],
				['header_vs_lines', 'warning'],
				['no_odoo_partner', 'warning'],
				['expired_items', 'warning'],
			]);
			expect(alerts.find((alert) => alert.code === 'balance')!.message).toContain('200,00');
			for (const alert of alerts) expect(alert.message).not.toMatch(/_id|total_value|final_price/);
		});

		it('sin problemas no hay alertas', () => {
			expect(
				ContractsService.buildAlerts({
					status: 'Activo',
					total_value: '100',
					items_count: '1',
					items_total: '100.005',
					invoices_count: '0',
					auto_send_to_odoo: false,
				})
			).toEqual([]);
		});
	});

	describe('normalizeEventType', () => {
		it.each([
			['churn', null, 'CHURN'],
			['CHURN_APPLIED', null, 'CHURN'],
			['cross_sell', null, 'CROSS_SELL'],
			['CROSS_SELL_APPLIED', null, 'CROSS_SELL'],
			['UPSELL_APPLIED', null, 'UPSELL'],
			['RENEWAL_APPLIED', null, 'RENEWAL'],
			['SIGNED', null, 'ACTIVATION'],
			['amendment', 'downsell', 'DOWNSELL'],
			['amendment', null, 'AMENDMENT'],
			['NON_RENEWAL', 'ITEM_CANCELLED', 'CHURN'],
			['INVOICE_CANCELLED', 'downsell', 'INVOICE_CANCELLED'],
			[null, null, 'OTHER'],
		])('%s / %s → %s', (type, subtype, expected) => {
			expect(ContractsService.normalizeEventType(type, subtype)).toBe(expected);
		});
	});

	it('parseStatusFilter: lista blanca, alias in_review y all', () => {
		expect(parseStatusFilter(undefined)).toEqual([]);
		expect(parseStatusFilter('all')).toEqual([]);
		expect(parseStatusFilter('active,all')).toEqual([]);
		expect(parseStatusFilter('in_review,draft,expired')).toEqual(['draft', 'expired']);
		expect(parseStatusFilter("active,x' OR 1=1")).toEqual(['active']);
	});
});

describe('deriveContractStatus', () => {
	const today = '2026-09-25';
	const item = (patch: Partial<StatusItem> = {}): StatusItem => ({
		is_recurring: true,
		categoria: 'NEW',
		churn_date: null,
		end_date: '2026-12-31',
		renewed_by_item_id: null,
		...patch,
	});

	it.each<[string, string | null, StatusItem[], string]>([
		['En revisión → draft', 'En revisión', [item({ end_date: '2025-01-01' })], 'draft'],
		['Cancelado → cancelled', 'Cancelado', [], 'cancelled'],
		['Pausado → paused', 'Pausado', [], 'paused'],
		['otro estado → other', 'Borrador', [], 'other'],
		['sin estado → other', null, [], 'other'],
		['Activo sin ítems → active', 'Activo', [], 'active'],
		['Activo solo con ítems no recurrentes vencidos → active', 'Activo', [item({ is_recurring: false, end_date: '2025-01-01' })], 'active'],
		['Activo con ítems vigentes → active', 'Activo', [item(), item({ end_date: null })], 'active'],
		['Activo con ítem futuro → active', 'Activo', [item({ end_date: '2027-12-31' })], 'active'],
		['vence hoy sigue vigente → active', 'Activo', [item({ end_date: today })], 'active'],
		['ítem vencido pero renovado → active', 'Activo', [item({ end_date: '2026-08-31', renewed_by_item_id: 'r' }), item()], 'active'],
		['ítem vencido con churn no cuenta → active', 'Activo', [item({ end_date: '2026-08-31', churn_date: '2026-08-31' }), item()], 'active'],
		[
			'ajuste CHURN/DOWNSELL vencido no cuenta → active',
			'Activo',
			[item({ end_date: '2026-08-31', categoria: 'DOWNSELL' }), item({ end_date: '2026-08-31', categoria: 'CHURN' }), item()],
			'active',
		],
		['uno vencido sin decisión y otro vigente → pending_renewal', 'Activo', [item({ end_date: '2026-09-24' }), item()], 'pending_renewal'],
		[
			'uno vencido sin decisión y otro futuro → pending_renewal',
			'Activo',
			[item({ end_date: '2026-09-24' }), item({ end_date: '2027-01-31' })],
			'pending_renewal',
		],
		['todos vencidos sin decisión → expired', 'Activo', [item({ end_date: '2026-09-24' }), item({ end_date: '2025-12-31' })], 'expired'],
		[
			'vencido sin decisión + vencido renovado cuyo renovador venció → expired',
			'Activo',
			[item({ end_date: '2025-12-31', renewed_by_item_id: 'b' }), item({ end_date: '2026-06-30' })],
			'expired',
		],
		['vencido + ítem churneado vigente → expired', 'Activo', [item({ end_date: '2026-06-30' }), item({ churn_date: '2026-09-01' })], 'expired'],
	])('%s', (_label, status, items, expected) => {
		expect(deriveContractStatus(status, items, today)).toBe(expected);
	});
});

describe('QueryContractsDto', () => {
	const errorsOf = async (query: Record<string, unknown>) =>
		(await validate(plainToInstance(QueryContractsDto, query))).map((error) => error.property);

	it('acepta estados en lista (con alias) y filtros avanzados válidos', async () => {
		await expect(
			errorsOf({
				status: 'active,pending_renewal,in_review',
				type: 'Nuevo cliente,Histórico,Renegociación',
				minValue: '10.5',
				maxValue: '900',
				startFrom: '2026-01-01',
				nextEndTo: '2026-10-31',
				multicompany: 'true',
				multicurrency: 'false',
				clientCountry: 'Chile,Perú',
				entityCountry: 'CL',
				autoInvoice: 'true',
				hasErpInvoice: 'false',
				sellerId: '22222222-2222-4222-8222-222222222222',
				sortBy: 'type',
			})
		).resolves.toEqual([]);
	});

	it('rechaza estados, fechas, booleanos y textos fuera de la lista blanca', async () => {
		await expect(
			errorsOf({
				status: 'active,vigente',
				type: "x'; DROP TABLE contracts; --",
				minValue: 'mucho',
				startFrom: '01-01-2026',
				multicompany: 'yes',
				clientCountry: 'Chile;Perú',
				hasErpInvoice: '1',
				sellerId: 'ana',
			})
		).resolves.toEqual(
			expect.arrayContaining(['status', 'type', 'minValue', 'startFrom', 'multicompany', 'clientCountry', 'hasErpInvoice', 'sellerId'])
		);
	});
});

describe('ContractSubscriptionsService', () => {
	const asOf = new Date('2026-09-25T12:00:00.000Z');
	const build = (impl: (sql: string) => unknown[]) => {
		const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) => impl(sql));
		const metrics = { systemCurrency: jest.fn().mockResolvedValue('USD') } as unknown as HoldingMetricsService;

		return { service: new ContractSubscriptionsService({ query } as unknown as DataSource, metrics), query };
	};

	it('lista paginada acotada al holding, con búsqueda, estados en lista blanca, orden y conteo por estado', async () => {
		const { service, query } = build((sql) => {
			if (sql.includes('GROUP BY s.status'))
				return [
					{ status: 'active', count: '3' },
					{ status: 'canceled', count: '5' },
					{ status: 'past_due', count: '1' },
				];

			return [
				{
					id: 'sub-1',
					external_id: 'sub_123',
					source: 'stripe',
					status: 'active',
					client_name: 'Acme',
					monthly_amount: '100',
					mrr: '95.5',
					mrr_source: 'subscription',
					items_count: '2',
					products: ['Plan Pro'],
					current_period_end: new Date('2026-10-01T00:00:00.000Z'),
					cancel_at_period_end: false,
				},
			];
		});

		const result = await service.list(
			'h-1',
			{ search: ' sub_1 ', status: 'active,past_due', sortBy: 'mrr', sortOrder: 'asc', page: 1, limit: 10 },
			asOf
		);
		const [listSql, params] = query.mock.calls.find(([sql]) => sql.includes('LIMIT '))!;
		const [countSql, countParams] = query.mock.calls.find(([sql]) => sql.includes('GROUP BY s.status'))!;

		expect(params).toEqual(['h-1', '2026-09-25', '%sub_1%']);
		expect(countParams).toBe(params);
		for (const sql of [listSql, countSql]) {
			expect(sql).toContain('s.holding_id = $1');
			expect(sql).toContain('s.external_id ILIKE $3');
			expect(sql).toContain('r.subscription_id = s.id AND r.holding_id = $1');
		}
		expect(listSql).toContain(`AND s.status IN ('active', 'past_due')`);
		expect(countSql).not.toContain(`AND s.status IN ('active', 'past_due')`);
		expect(listSql).toContain('ORDER BY m.mrr ASC NULLS LAST, s.id');
		expect(result).toMatchObject({
			items: 4,
			pages: 1,
			currentPage: 1,
			limit: 10,
			counts: { all: 9, active: 3, canceled: 5, past_due: 1, trialing: 0 },
		});
		expect(result.data[0]).toMatchObject({
			stripe_subscription_id: 'sub_123',
			mrr: 95.5,
			mrr_source: 'subscription',
			items_count: 2,
			products: ['Plan Pro'],
			current_period_end: '2026-10-01T00:00:00.000Z',
			cancel_at_period_end: false,
		});
	});

	it('ordena solo por la lista blanca', async () => {
		const { service, query } = build(() => []);

		await service.list('h-1', { sortBy: 'x; DROP TABLE subscriptions' as never }, asOf);
		expect(query.mock.calls.find(([sql]) => sql.includes('LIMIT '))![0]).toContain('ORDER BY s.start_date DESC NULLS LAST, s.id');
	});

	it('resumen: activas y MRR del mes en moneda del sistema', async () => {
		const { service, query } = build(() => [{ active: '157', past_due: '20', mrr: '1234.567' }]);

		await expect(service.summary('h-1', asOf)).resolves.toEqual({
			as_of: '2026-09-25',
			currency: 'USD',
			active: 157,
			past_due: 20,
			mrr: 1234.57,
		});
		expect(query.mock.calls[0][1]).toEqual(['h-1', '2026-09-25']);
	});

	it('parseSubscriptionStatus y el DTO solo aceptan estados conocidos', async () => {
		expect(parseSubscriptionStatus('active,all')).toEqual([]);
		expect(parseSubscriptionStatus('active,foo,past_due')).toEqual(['active', 'past_due']);
		const errors = await validate(plainToInstance(QueryContractSubscriptionsDto, { status: 'active,foo', sortBy: 'id' }));

		expect(errors.map((error) => error.property)).toEqual(['status', 'sortBy']);
	});
});

describe('ContractsController', () => {
	it('exige sesión y holding (HoldingScopeGuard: 400 sin header, 403 holding ajeno)', () => {
		expect(Reflect.getMetadata(GUARDS_METADATA, ContractsController)).toEqual([SupabaseAuthGuard, HoldingScopeGuard]);
	});

	it('pasa el holding del guard al servicio', async () => {
		const service = { detail: jest.fn().mockResolvedValue({ id: CONTRACT_ID }) } as unknown as ContractsService;
		const controller = new ContractsController(
			service,
			{} as ContractDraftsService,
			{} as ContractSubscriptionsService,
			{} as Contract360Service,
			{} as ContractBulkService,
			{} as ContractActivationService
		);

		await controller.detail(CONTRACT_ID, 'h-1');
		expect(service.detail).toHaveBeenCalledWith(CONTRACT_ID, 'h-1');
	});

	it('suscripciones: pasa el holding del guard y la query', async () => {
		const subscriptions = {
			list: jest.fn().mockResolvedValue({ data: [] }),
			summary: jest.fn().mockResolvedValue({}),
		} as unknown as ContractSubscriptionsService;
		const controller = new ContractsController(
			{} as ContractsService,
			{} as ContractDraftsService,
			subscriptions,
			{} as Contract360Service,
			{} as ContractBulkService,
			{} as ContractActivationService
		);

		await controller.subscriptions({ status: 'active' }, 'h-1');
		await controller.subscriptionsSummary('h-1');
		expect(subscriptions.list).toHaveBeenCalledWith('h-1', { status: 'active' });
		expect(subscriptions.summary).toHaveBeenCalledWith('h-1');
	});
});
