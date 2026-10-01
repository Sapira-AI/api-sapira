// `InvoiceSchedulerService` (envío al ERP desde el Contrato 360) importa `uuid`, que desde la v13 es solo ESM: Jest no lo transforma.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

import { NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource } from 'typeorm';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { HoldingMetricsService } from '@/modules/metrics/holding-metrics.service';

import { ConsumptionService } from './consumption.service';
import { Contract360Service } from './contract-360.service';
import { ContractActivationService } from './contract-activation.service';
import { ContractBulkService } from './contract-bulk.service';
import { ContractChangesService } from './contract-changes.service';
import { ContractDraftsService } from './contract-drafts.service';
import { ContractInvoiceDescriptionsService } from './contract-invoice-descriptions.service';
import { ContractInvoiceEditService } from './contract-invoice-edit.service';
import { ContractInvoicesService } from './contract-invoices.service';
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
			expect(listCall(query)[0]).toContain('c.deleted_at IS NULL');
			expect(countCall(query)[0]).toContain('c.deleted_at IS NULL');
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
				expect(sql).toContain('c.deleted_at IS NULL');
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
			expect(query.mock.calls[0][0]).toContain('c.deleted_at IS NULL');
		});

		it('detail expone día de ciclo, condición de pago y tipo de documento, y las fechas del servicio sin bajas ni ajustes', async () => {
			const { service, query } = build((sql) => {
				if (sql.includes('LIMIT 1')) return [{ id: CONTRACT_ID, status: 'Activo' }];
				if (sql.includes('cl.name_commercial AS client_name'))
					return [
						{
							id: CONTRACT_ID,
							status: 'Activo',
							derived_status: 'active',
							billing_anchor_day: '5',
							payment_terms: { kind: 'end_of_month', days: 15 },
							document_type: 'FACTURA_EXPORTACION',
							requires_multicurrency_billing: true,
							requires_multicompany_billing: null,
							start_date: '2025-10-01',
							end_date: '2026-09-30',
						},
					];

				return [];
			});

			const result = await service.detail(CONTRACT_ID, 'h-1', asOf);
			const [sql] = query.mock.calls.find(([text]) => (text as string).includes('cl.name_commercial AS client_name'))!;

			expect(result).toMatchObject({
				billing_anchor_day: 5,
				payment_terms: { kind: 'end_of_month', days: 15 },
				document_type: 'FACTURA_EXPORTACION',
				requires_multicurrency_billing: true,
				requires_multicompany_billing: false,
				start_date: '2025-10-01',
				end_date: '2026-09-30',
			});
			expect(sql).toContain('c.billing_anchor_day, c.payment_terms, c.document_type');
			expect(sql).toContain(`ci.churn_date IS NULL AND COALESCE(ci.categoria, '') NOT IN ('CHURN', 'DOWNSELL')`);
			expect(sql).toContain('COALESCE(cd.end_date, c.contract_end_date)');
			expect(sql).not.toContain('to_jsonb');
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

		it('ítems: une prices, billable_metrics y el precio de catálogo, y los expone en cada ítem y en el grupo', async () => {
			const priceRow = {
				price_id: 'pr-1',
				price_name: 'Ruteo por volumen',
				price_version: 2,
				price_status: 'active',
				price_model: 'volume',
				price_quantity_type: 'metered',
				price_billable_metric_id: 'bm-1',
				price_unit_amount: null,
				price_tiers: [
					{ from: 0, to: 500, per_unit_amount: '0.08', flat_amount: '10' },
					{ from: 500, to: null, per_unit_amount: '0.05', flat_amount: 0 },
				],
				price_package_size: null,
				price_package_amount: null,
				price_seat_minimum_quantity: '0',
				price_free_units: '100',
				price_minimum_amount: '50',
				price_cap_amount: null,
				price_invoice_line_mode: 'per_tier',
				price_charge_flat_when_free: false,
				price_list_price_id: 'lp-1',
				metric_id: 'bm-1',
				metric_code: 'rutas',
				metric_name: 'Rutas completadas',
				metric_unit: 'ruta',
				metric_aggregation: 'sum',
				catalog_price_id: 'lp-1',
				catalog_price_name: 'Ruteo lista',
				catalog_price_version: 3,
			};
			const { service, query } = build((sql) => {
				if (sql.includes('LIMIT 1')) return [{ id: CONTRACT_ID, status: 'Activo' }];
				if (sql.includes('FROM contract_items ci'))
					return [
						{
							id: 'a',
							product_name: 'RUTEO',
							quantity: '2000',
							unit_price: '0.035',
							monthly_price: '70',
							billing_period_price: '70',
							is_recurring: true,
							start_date: '2026-01-01',
							end_date: '2026-12-31',
							categoria: 'NEW',
							currency: 'CLF',
							...priceRow,
						},
						{
							id: 'b',
							product_name: 'SOPORTE',
							quantity: '1',
							unit_price: '5',
							monthly_price: '5',
							billing_period_price: '5',
							is_recurring: true,
							start_date: '2026-01-01',
							end_date: '2026-12-31',
							categoria: 'NEW',
							currency: 'CLF',
							price_id: null,
							metric_id: null,
							catalog_price_id: null,
						},
					];

				return [];
			});

			const result = await service.items(CONTRACT_ID, 'h-1', asOf);
			const [sql] = query.mock.calls.find(([text]) => (text as string).includes('FROM contract_items ci'))!;

			expect(sql).toContain('LEFT JOIN prices p ON p.id = ci.price_id');
			expect(sql).toContain('LEFT JOIN billable_metrics bm ON bm.id = p.billable_metric_id');
			expect(sql).toContain('LEFT JOIN prices lp ON lp.id = p.list_price_id');
			expect(sql).toContain('p.list_price_id AS price_list_price_id');

			const [ruteo, soporte] = result.items;

			expect(ruteo.price).toEqual({
				id: 'pr-1',
				name: 'Ruteo por volumen',
				version: 2,
				status: 'active',
				list_price_id: 'lp-1',
				model: 'volume',
				quantity_type: 'metered',
				billable_metric_id: 'bm-1',
				unit_amount: null,
				tiers: [
					{ from: 0, to: 500, per_unit_amount: 0.08, flat_amount: 10 },
					{ from: 500, to: null, per_unit_amount: 0.05, flat_amount: 0 },
				],
				package_size: null,
				package_amount: null,
				seat_minimum_quantity: 0,
				free_units: 100,
				minimum_amount: 50,
				cap_amount: null,
				invoice_line_mode: 'per_tier',
				charge_flat_when_free: false,
			});
			expect(ruteo).toMatchObject({
				unit_price: 0.035,
				uses_price_model: true,
				metric: { id: 'bm-1', code: 'rutas', name: 'Rutas completadas', unit: 'ruta', aggregation: 'sum' },
				catalog_price: { id: 'lp-1', name: 'Ruteo lista', version: 3 },
			});
			expect(soporte).toMatchObject({ price: null, metric: null, catalog_price: null, uses_price_model: false });

			const byProduct = Object.fromEntries(result.groups.map((group) => [group.product_name, group]));

			expect(byProduct.RUTEO).toMatchObject({
				uses_price_model: true,
				price: ruteo.price,
				metric: ruteo.metric,
				catalog_price: ruteo.catalog_price,
			});
			expect(byProduct.SOPORTE).toMatchObject({ uses_price_model: false, price: null, metric: null, catalog_price: null });
		});

		it('facturas: filtra por estado sin parámetros sueltos y cuenta por estado', async () => {
			const { service, query } = build((sql) => {
				if (sql.includes('LIMIT 1')) return [{ id: CONTRACT_ID }];
				if (sql.includes('all_count')) return [{ all_count: '5', pending_count: '2', issued_count: '2', cancelled_count: '1' }];
				if (sql.includes('OFFSET'))
					return [
						{
							id: 'inv-1',
							status: 'Emitida',
							contract_currency: 'USD',
							invoice_currency: 'CLP',
							fx_contract_to_invoice: '950.5',
							issued_externally: true,
							original_issue_date: '2026-02-01',
							issue_date: '2026-03-01',
						},
					];

				return [];
			});

			const result = await service.invoices(CONTRACT_ID, 'h-1', { status: 'issued', sortBy: 'amount', sortOrder: 'desc' });
			const [sql, params] = query.mock.calls.find(([text]) => (text as string).includes('OFFSET'))!;

			expect(params).toEqual([CONTRACT_ID, 'h-1']);
			expect(sql).toContain(`i.status IN ('Emitida', 'Enviada', 'Vencida', 'Pagada')`);
			expect(sql).toContain('ORDER BY i.amount_contract_currency DESC NULLS LAST, i.issue_date DESC NULLS LAST, i.id');
			expect(result).toMatchObject({ items: 2, counts: { all: 5, pending: 2, issued: 2, cancelled: 1 } });
			// Columnas de las etapas 1–2 de Facturas en el 360 en cada fila de la lista.
			expect(result.data[0]).toMatchObject({
				fx_policy: 'fixed',
				fx_rate: 950.5,
				issued_externally: true,
				original_issue_date: '2026-02-01',
				issue_date: '2026-03-01',
			});
		});

		it('facturas (etapa 4): motivo del desvío, líneas manuales, sin cobro y "Restablecer borrador del ERP" por fila', async () => {
			const { service, query } = build((sql) => {
				if (sql.includes('LIMIT 1')) return [{ id: CONTRACT_ID }];
				if (sql.includes('all_count')) return [{ all_count: '2', pending_count: '1', issued_count: '0', cancelled_count: '1' }];
				if (sql.includes('OFFSET'))
					return [
						{
							id: 'inv-1',
							status: 'Por Emitir',
							is_active: true,
							odoo_invoice_id: '321',
							sent_to_odoo_at: '2026-09-20T10:00:00.000Z',
							has_manual_lines: true,
							no_charge: false,
							doc_type: 'FACTURA',
							deviation_id: 'adj-1',
							deviation_type: 'discount',
							deviation_amount_diff: '-100',
							deviation_reason: 'Promo',
							deviation_adjusted_at: new Date('2026-09-29T10:00:00.000Z'),
							deviation_adjusted_by_name: 'Domi',
						},
						{ id: 'inv-2', status: 'Cancelada', is_active: true, no_charge: true, odoo_invoice_id: null, sent_to_odoo_at: null },
					];

				return [];
			});
			const result = await service.invoices(CONTRACT_ID, 'h-1', { status: 'all' });
			const [sql] = query.mock.calls.find(([text]) => (text as string).includes('OFFSET'))!;

			expect(sql).toContain("mi.quantity_source = 'manual'");
			expect(sql).toContain("'INVOICE_NO_CHARGE', 'INVOICE_NO_CHARGE_REVERTED'");
			expect(sql).toContain("a.type IN ('discount', 'upsell', 'downsell', 'correction')");
			expect(result.data[0]).toMatchObject({
				has_manual_lines: true,
				no_charge: false,
				erp_sync_state: 'draft',
				erp_reset_available: true,
				deviation: {
					has_reason: true,
					type: 'discount',
					amount_diff: -100,
					reason: 'Promo',
					adjusted_at: '2026-09-29T10:00:00.000Z',
					adjusted_by_name: 'Domi',
				},
			});
			expect(result.data[1]).toMatchObject({
				status: 'Cancelada',
				no_charge: true,
				deviation: null,
				erp_sync_state: 'none',
				erp_reset_available: false,
			});
		});

		it('facturas: por defecto ordena por período de servicio y desempata por emisión; por emisión no repite el desempate', async () => {
			const rows = (sql: string) => (sql.includes('LIMIT 1') ? [{ id: CONTRACT_ID }] : sql.includes('all_count') ? [{ all_count: '0' }] : []);
			const byPeriod = build(rows);

			await byPeriod.service.invoices(CONTRACT_ID, 'h-1', {});
			expect(byPeriod.query.mock.calls.find(([text]) => (text as string).includes('OFFSET'))![0]).toContain(
				'ORDER BY lines.billing_period_start ASC NULLS LAST, i.issue_date ASC NULLS LAST, i.id'
			);

			const byIssue = build(rows);

			await byIssue.service.invoices(CONTRACT_ID, 'h-1', { sortBy: 'issue_date', sortOrder: 'desc' });
			expect(byIssue.query.mock.calls.find(([text]) => (text as string).includes('OFFSET'))![0]).toContain(
				'ORDER BY i.issue_date DESC NULLS LAST, i.id'
			);
		});

		it('facturas (multimoneda §9): documento unificado legacy o v2 con aporte por contrato en una sola consulta; sin unificados no consulta', async () => {
			const page = [
				{ id: 'inv-u', status: 'Por Emitir', invoice_type: 'Unificada', is_active: true },
				{ id: 'inv-v2', status: 'Por Emitir', invoice_type: 'Unificada', is_active: true },
				{ id: 'inv-1', status: 'Emitida', invoice_type: 'Automatica', is_active: true },
			];
			const { service, query } = build((sql) => {
				if (sql.includes('LIMIT 1')) return [{ id: CONTRACT_ID }];
				if (sql.includes('all_count')) return [{ all_count: '3' }];
				if (sql.includes('OFFSET')) return page;
				if (sql.includes('consolidated_v2'))
					return [
						{
							invoice_id: 'inv-u',
							consolidated_v2: false,
							contract_id: 'ctr-a',
							contract_number: 'CTR-1',
							currency: 'USD',
							lines_count: '1',
							subtotal: '10',
							subtotal_invoice_currency: '9500',
						},
						{
							invoice_id: 'inv-u',
							consolidated_v2: false,
							contract_id: 'ctr-b',
							contract_number: 'CTR-2',
							currency: 'USD',
							lines_count: '2',
							subtotal: '20',
							subtotal_invoice_currency: '19000',
						},
						{
							invoice_id: 'inv-v2',
							consolidated_v2: true,
							contract_id: 'ctr-a',
							contract_number: 'CTR-1',
							currency: 'CLP',
							lines_count: '1',
							subtotal: '5',
							subtotal_invoice_currency: '5',
						},
					];

				return [];
			});
			const result = await service.invoices(CONTRACT_ID, 'h-1', { status: 'all' });
			const unifiedCalls = query.mock.calls.filter(([text]) => (text as string).includes('consolidated_v2'));

			expect(unifiedCalls).toHaveLength(1);
			expect(unifiedCalls[0][1]).toEqual([['inv-u', 'inv-v2'], 'h-1']);
			expect(result.data[0]).toMatchObject({
				legacy_unified: true,
				contributions: [
					{ contract_id: 'ctr-b', contract_number: 'CTR-2', lines_count: 2, subtotal_invoice_currency: 19000 },
					{ contract_id: 'ctr-a', contract_number: 'CTR-1', lines_count: 1, subtotal_invoice_currency: 9500 },
				],
			});
			expect(result.data[1]).toMatchObject({
				legacy_unified: false,
				contributions: [{ contract_id: 'ctr-a', subtotal_by_currency: [{ currency: 'CLP', subtotal: 5 }] }],
			});
			expect(result.data[2]).not.toHaveProperty('legacy_unified');
			expect(result.data[2]).not.toHaveProperty('contributions');

			const plain = build((sql) =>
				sql.includes('LIMIT 1') ? [{ id: CONTRACT_ID }] : sql.includes('OFFSET') ? [page[2]] : [{ all_count: '1' }]
			);

			await plain.service.invoices(CONTRACT_ID, 'h-1', {});
			expect(plain.query.mock.calls.some(([text]) => (text as string).includes('consolidated_v2'))).toBe(false);
		});

		describe('invoiceDetail', () => {
			const INVOICE_ID = '33333333-3333-4333-8333-333333333333';
			const header = {
				id: INVOICE_ID,
				invoice_number: 'F-1046',
				status: 'Pagada',
				document_type: 'FACTURA',
				issue_date: '2026-03-01',
				original_issue_date: '2026-03-01',
				scheduled_at: '2026-03-01',
				due_date: '2026-03-31',
				created_at: new Date('2026-02-20T10:00:00.000Z'),
				billing_period_start: '2026-03-01',
				billing_period_end: '2026-03-31',
				contract_currency: 'CLF',
				invoice_currency: 'CLP',
				amount_contract_currency: '110.6',
				amount_invoice_currency: '4185387',
				vat: '795223',
				total_invoice_currency: '4980610',
				fx_contract_to_invoice: '37842.2',
				tax_rate: '0.19',
				is_active: true,
				odoo_invoice_id: 12,
				sent_to_odoo_at: new Date('2026-03-01T12:00:00.000Z'),
				requires_references_for_billing: true,
				lines_count: '2',
				legal_name: 'Acme SpA',
				tax_document_type_id: null,
				own_description_max_chars: null,
				company_country: 'Chile',
				contract_document_type: 'FACTURA',
				description_limits: '[{"country_code":"CL","kind":"invoice","description_max_chars":80,"sort":10}]',
			};
			const route = (sql: string) => {
				if (sql.includes('LIMIT 1')) return [{ id: CONTRACT_ID }];
				if (sql.includes('FROM invoice_items ii') && sql.includes('pricing_breakdown')) {
					return [
						{
							id: 'l-1',
							description: 'Rutas optimizadas',
							quantity: '1250',
							unit_of_measure: 'rutas',
							quantity_source: 'consumption',
							unit_price_contract_currency: '0.08',
							subtotal_contract_currency: '100',
							tax_amount_contract_currency: '19',
							total_contract_currency: '119',
							billing_period_start: '2026-03-01',
							billing_period_end: '2026-03-31',
							contract_item_id: 'ci-1',
							product_name: 'Rutas',
							pricing_breakdown:
								'[{"kind":"tier","tier_index":0,"from":0,"to":1000,"quantity":1000,"unit_amount":0.1,"amount":100,"label":"0–1.000"}]',
						},
						{
							id: 'l-2',
							description: 'Soporte',
							quantity: '1',
							subtotal_contract_currency: '10.6',
							pricing_breakdown: [{ kind: 'seat', quantity: 1, amount: 10.6, label: 'Asiento' }],
						},
					];
				}
				if (sql.includes('FROM invoice_references r'))
					return [{ id: 'r-1', type: 'OC', name: 'Orden de Compra', code: '5020333', date: '2026-02-15', source: 'invoice' }];
				if (sql.includes('FROM invoice_adjustments a')) {
					return [
						{
							id: 'a-1',
							type: 'discount',
							amount_diff: '-5',
							notes: 'Descuento comercial',
							adjusted_at: new Date('2026-03-05T09:00:00.000Z'),
							user_id: 'u-1',
							user_name: 'María José',
						},
					];
				}
				if (sql.includes("'credit_note'"))
					return [
						{
							id: 'nc-1',
							invoice_number: 'NC-12',
							document_type: 'NC',
							status: 'Emitida',
							issue_date: '2026-03-10',
							relation: 'credit_note',
						},
					];
				if (sql.includes('JOIN contract_lifecycle_events e'))
					return [
						{
							id: 'e-1',
							event_type: 'INVOICE_RESCHEDULED',
							event_subtype: null,
							title: 'Factura reprogramada al 2026-03-01',
							description: 'Emisión 2026-02-01 → 2026-03-01',
							effective_date: '2026-03-01',
							created_at: new Date('2026-02-20T11:00:00.000Z'),
							metadata: {
								source: 'contract_360',
								invoice_id: INVOICE_ID,
								before: { issue_date: '2026-02-01' },
								after: { issue_date: '2026-03-01' },
							},
							user_id: 'u-1',
							user_name: 'María José',
						},
					];
				if (sql.includes('FROM invoices i') && sql.includes('i.id = $1::uuid AND i.contract_id = $2')) return [header];

				return [];
			};

			it('devuelve encabezado, líneas con desglose (texto u objeto), referencias, ajustes y documentos relacionados, acotados al contrato y holding', async () => {
				const { service, query } = build(route);

				const result = await service.invoiceDetail(CONTRACT_ID, INVOICE_ID, 'h-1');

				for (const [sql, params] of query.mock.calls.slice(1)) {
					expect(sql).toContain('i.contract_id = $2 AND i.holding_id = $3');
					expect(params).toEqual([INVOICE_ID, CONTRACT_ID, 'h-1']);
				}
				expect(result).toMatchObject({
					id: INVOICE_ID,
					invoice_number: 'F-1046',
					amount_contract_currency: 110.6,
					fx_contract_to_invoice: 37842.2,
					tax_rate: 0.19,
					sent_to_odoo_at: '2026-03-01T12:00:00.000Z',
					created_at: '2026-02-20T10:00:00.000Z',
					requires_references_for_billing: true,
					lines_count: 2,
					references: [{ id: 'r-1', type: 'OC', code: '5020333', source: 'invoice' }],
					adjustments: [
						{
							id: 'a-1',
							type: 'discount',
							amount_diff: -5,
							adjusted_at: '2026-03-05T09:00:00.000Z',
							adjusted_by: { id: 'u-1', name: 'María José' },
						},
					],
					related_documents: [{ id: 'nc-1', invoice_number: 'NC-12', relation: 'credit_note' }],
					// Etapas 1–2 de Facturas en el 360: FX por factura (derivado de moneda + fx_contract_to_invoice), emisión externa (por evento), estado ERP derivado e historial.
					fx_policy: 'fixed',
					fx_rate: 37842.2,
					fx_rate_source: null,
					fx_confirmed_at: null,
					issued_externally: false,
					erp_sync_state: 'sent',
					history: [
						{
							id: 'e-1',
							type: 'INVOICE_RESCHEDULED',
							title: 'Factura reprogramada al 2026-03-01',
							effective_date: '2026-03-01',
							created_at: '2026-02-20T11:00:00.000Z',
							created_by: { id: 'u-1', name: 'María José' },
							metadata: { invoice_id: INVOICE_ID, after: { issue_date: '2026-03-01' } },
						},
					],
				});
				const historySql = query.mock.calls.find(([sql]) => (sql as string).includes('JOIN contract_lifecycle_events e'))![0] as string;

				expect(historySql).toContain(`e.metadata->>'invoice_id' = i.id::text`);
				expect(historySql).toContain(`e.metadata->'created_invoices' ? i.id::text`);
				// NC de modificaciones y documentos del consumo (reemisión, complementaria) también aparecen en el historial de la factura.
				expect(historySql).toContain(`e.metadata->'created_credit_notes' ? i.id::text`);
				expect(historySql).toContain(`e.metadata->>'credit_note_id' = i.id::text`);
				expect(historySql).toContain(`e.metadata->>'cancelled_invoice_id' = i.id::text`);
				expect(historySql).toContain(`e.metadata->>'complements_invoice_id' = i.id::text`);
				expect(result.lines).toHaveLength(2);
				expect(result.lines[0]).toMatchObject({
					description: 'Rutas optimizadas',
					quantity: 1250,
					quantity_source: 'consumption',
					subtotal_contract_currency: 100,
					tax_contract_currency: 19,
					product_name: 'Rutas',
					pricing_breakdown: [{ kind: 'tier', quantity: 1000, amount: 100 }],
				});
				expect(result.lines[1].pricing_breakdown).toEqual([{ kind: 'seat', quantity: 1, amount: 10.6, label: 'Asiento' }]);
				expect(result.lines[1].quantity_source).toBeNull();
				// Etapa 3 (§3.6): protección por línea y límite del documento (contrato sin documento del catálogo → el de su país y familia).
				expect(result.description_max_chars).toBe(80);
				expect(result.lines.map((line) => line.description_locked)).toEqual([false, false]);
				expect(result.references[0].kind).toBe('OC');
				const [linesSql] = query.mock.calls.find(
					([sql]) => (sql as string).includes('FROM invoice_items ii') && (sql as string).includes('pricing_breakdown')
				)!;

				expect(linesSql).toContain('ii.description_locked');
				// Etapa 4 (§3.4): motivo del desvío (último invoice_adjustments), líneas manuales, visibilidad por línea, sin cobro y ERP.
				expect(result).toMatchObject({
					deviation: {
						has_reason: true,
						type: 'discount',
						amount_diff: -5,
						reason: 'Descuento comercial',
						adjusted_at: '2026-03-05T09:00:00.000Z',
						adjusted_by_name: 'María José',
					},
					has_manual_lines: false,
					no_charge: false,
					erp_reset_available: false,
				});
				expect(result.lines.map((line) => line.is_visible)).toEqual([true, true]);
			});

			it('documento unificado (multimoneda §9): legacy_unified y aporte por contrato; una factura común no los trae ni consulta', async () => {
				const unified = build((sql) =>
					sql.includes('consolidated_v2')
						? [
								{
									invoice_id: INVOICE_ID,
									consolidated_v2: false,
									contract_id: CONTRACT_ID,
									contract_number: 'CTR-1',
									currency: 'CLF',
									lines_count: '2',
									subtotal: '110.6',
									subtotal_invoice_currency: null,
								},
							]
						: sql.includes('FROM invoices i') && sql.includes('i.id = $1::uuid AND i.contract_id = $2')
							? [{ ...header, invoice_type: 'Unificada' }]
							: route(sql)
				);
				const result = await unified.service.invoiceDetail(CONTRACT_ID, INVOICE_ID, 'h-1');

				expect(result).toMatchObject({
					invoice_type: 'Unificada',
					legacy_unified: true,
					contributions: [{ contract_id: CONTRACT_ID, contract_number: 'CTR-1', lines_count: 2, subtotal_invoice_currency: null }],
				});
				const plain = build(route);
				const common = await plain.service.invoiceDetail(CONTRACT_ID, INVOICE_ID, 'h-1');

				expect(common).not.toHaveProperty('legacy_unified');
				expect(plain.query.mock.calls.some(([text]) => (text as string).includes('consolidated_v2'))).toBe(false);
			});

			it('responde 404 si la factura no es del contrato (o el contrato no es del holding)', async () => {
				const { service } = build((sql) => (sql.includes('LIMIT 1') ? [{ id: CONTRACT_ID }] : []));

				await expect(service.invoiceDetail(CONTRACT_ID, INVOICE_ID, 'h-1')).rejects.toBeInstanceOf(NotFoundException);

				const other = build(notInHolding);

				await expect(other.service.invoiceDetail(CONTRACT_ID, INVOICE_ID, 'h-otro')).rejects.toBeInstanceOf(NotFoundException);
				expect(other.query).toHaveBeenCalledTimes(1);
			});
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
			{} as ContractActivationService,
			{} as ConsumptionService,
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

		await controller.detail(CONTRACT_ID, 'h-1');
		expect(service.detail).toHaveBeenCalledWith(CONTRACT_ID, 'h-1');
	});

	it('detalle de factura: pasa contrato, factura y holding del guard al servicio', async () => {
		const INVOICE_ID = '33333333-3333-4333-8333-333333333333';
		const service = { invoiceDetail: jest.fn().mockResolvedValue({ id: INVOICE_ID, lines: [] }) } as unknown as ContractsService;
		const controller = new ContractsController(
			service,
			{} as ContractDraftsService,
			{} as ContractSubscriptionsService,
			{} as Contract360Service,
			{} as ContractBulkService,
			{} as ContractActivationService,
			{} as ConsumptionService,
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

		await expect(controller.invoiceDetail('CTR-2026-184', INVOICE_ID, 'h-1')).resolves.toEqual({ id: INVOICE_ID, lines: [] });
		expect(service.invoiceDetail).toHaveBeenCalledWith('CTR-2026-184', INVOICE_ID, 'h-1');
	});

	it('descarga de documentos: pasa contrato, documento y holding del guard al servicio 360', async () => {
		const DOC_ID = '22222222-2222-4222-8222-222222222222';
		const contract360 = {
			documentDownloadUrl: jest.fn().mockResolvedValue({ url: 'https://storage.test/x', expires_at: '2026-09-25T12:01:00.000Z' }),
		};
		const controller = new ContractsController(
			{} as ContractsService,
			{} as ContractDraftsService,
			{} as ContractSubscriptionsService,
			contract360 as unknown as Contract360Service,
			{} as ContractBulkService,
			{} as ContractActivationService,
			{} as ConsumptionService,
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

		await expect(controller.documentDownloadUrl('CTR-2026-184', DOC_ID, 'h-1')).resolves.toEqual({
			url: 'https://storage.test/x',
			expires_at: '2026-09-25T12:01:00.000Z',
		});
		expect(contract360.documentDownloadUrl).toHaveBeenCalledWith('CTR-2026-184', DOC_ID, 'h-1');
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
			{} as ContractActivationService,
			{} as ConsumptionService,
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

		await controller.subscriptions({ status: 'active' }, 'h-1');
		await controller.subscriptionsSummary('h-1');
		expect(subscriptions.list).toHaveBeenCalledWith('h-1', { status: 'active' });
		expect(subscriptions.summary).toHaveBeenCalledWith('h-1');
	});
});
