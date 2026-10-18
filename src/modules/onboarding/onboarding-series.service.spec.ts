import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { legacyCountedConditions } from '@/modules/metrics/mrr-historico';
import { fakeDb, Handler } from '@/modules/settings/fake-db.testing-spec';

import { OnboardingSeriesService } from './onboarding-series.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const COMPANY = '22222222-2222-4222-8222-222222222222';
const CLIENT = '33333333-3333-4333-8333-333333333333';
const ENTITY = '44444444-4444-4444-8444-444444444444';

function build(handlers: Handler[] = [], start: string | null = null) {
	const db = fakeDb([
		...handlers,
		['AS first_month, to_char(MAX(m.period_month)', () => [{ first_month: '2024-11', last_month: '2025-03' }]],
		["'metrics_history_start'", () => [{ start: start ? `${start}-01` : null }]],
		['SELECT system_currency FROM holding_settings', () => [{ system_currency: 'USD' }]],
		[
			'WITH linked AS',
			() => [
				{ month: '2025-02', contracts: '80.456' },
				{ month: '2025-03', contracts: '200' },
			],
		],
		['AS lines', () => [{ lines: '4', clients: '2' }]],
	]);

	return { db, service: new OnboardingSeriesService(db as unknown as DataSource) };
}

const amountsSql = (db: ReturnType<typeof fakeDb>) => db.statements('AS counted_system')[0];

describe('serie mensual del MRR histórico (Domi 18-10)', () => {
	it('moneda de sistema: cuenta con la regla U14 única, separa solape y quitadas, rellena meses vacíos y suma el devengo empalmado', async () => {
		const { db, service } = build(
			[
				[
					'AS counted_system',
					() => [
						{ month: '2025-01', currency: '', counted: '100.004', cut: '0', removed: '7', counted_system: '100.004' },
						{ month: '2025-02', currency: '', counted: '40', cut: '60', removed: '0', counted_system: '40' },
						{ month: '2025-03', currency: '', counted: '0', cut: '100', removed: '0', counted_system: '0' },
					],
				],
			],
			'2025-01'
		);
		const result = await service.series(HOLDING, {});
		const { sql } = amountsSql(db);

		// Una sola regla de qué cuenta (Métricas, Clientes, Cliente 360 y onboarding): recurrente + corte U14 + no quitada.
		expect(sql).toContain(`FILTER (WHERE ${legacyCountedConditions().join(' AND ')})`.replace(/\s+/g, ' '));
		expect(sql).toContain('(f.first_month IS NOT NULL AND m.period_month >= f.first_month)');
		expect(sql).toContain('SUM(m.mrr_legacy_system_currency)');
		expect(sql).toContain('COALESCE(m.is_recurring, false) = true');
		expect(result).toEqual({
			currency_mode: 'system',
			system_currency: 'USD',
			// Inicio de la historia del holding (2025-01) posterior al primer dato (2024-11): manda el inicio; hasta el último dato.
			months: [
				{ month: '2025-01', counted: 100, cut: 0, removed: 7, contracts: 0, by_currency: [] },
				{ month: '2025-02', counted: 40, cut: 60, removed: 0, contracts: 80.46, by_currency: [] },
				{ month: '2025-03', counted: 0, cut: 100, removed: 0, contracts: 200, by_currency: [] },
			],
			totals: { last_month: '2025-03', counted_last: 0, lines: 4, clients: 2 },
			filters_applied: { currency: 'system', companyId: null, clientId: null, entityId: null, country: null, from: '2025-01', to: '2025-03' },
		});
	});

	it('el devengo de los contratos empalmados usa la columna y el filtro de Métricas (plan, sin pendiente de renovar ni totales)', async () => {
		const { db, service } = build();

		await service.series(HOLDING, { from: '2025-01', to: '2025-03' });
		const [contracts] = db.statements('WITH linked AS');

		expect(contracts.sql).toContain('SUM(r.mrr_period_contracted_system_ccy)');
		expect(contracts.sql).toContain("r.momentum IS DISTINCT FROM 'PENDING_RENEWAL'");
		expect(contracts.sql).toContain('COALESCE(r.is_total_row, false) = false');
		expect(contracts.sql).toContain('c.deleted_at IS NULL');
		// Los contratos salen de las filas del filtro sin el rango; el devengo va en el rango.
		expect(contracts.sql).toMatch(/m\.migrated_to_contract_id IS NOT NULL \) SELECT/);
		expect(contracts.sql).not.toMatch(/m\.period_month BETWEEN/);
		expect(contracts.sql).toContain('r.period_month BETWEEN $2::date AND $3::date');
		expect(contracts.params).toEqual([HOLDING, '2025-01-01', '2025-03-01']);
	});

	it('moneda de contrato: los montos del mes son null y by_currency trae una entrada por moneda; contracts sigue en sistema', async () => {
		const { db, service } = build([
			[
				'AS counted_system',
				() => [
					{ month: '2025-02', currency: 'CLP', counted: '90000', cut: '0', removed: '0', counted_system: '100' },
					{ month: '2025-02', currency: 'USD', counted: '50', cut: '10', removed: '5', counted_system: '50' },
				],
			],
		]);
		const result = await service.series(HOLDING, { currency: 'contract', from: '2025-02', to: '2025-02' });

		expect(amountsSql(db).sql).toContain('m.contract_currency AS currency');
		expect(amountsSql(db).sql).toContain('SUM(m.mrr_legacy) FILTER');
		expect(result.months).toEqual([
			{
				month: '2025-02',
				counted: null,
				cut: null,
				removed: null,
				contracts: 80.46,
				by_currency: [
					{ currency: 'CLP', counted: 90000, cut: 0, removed: 0 },
					{ currency: 'USD', counted: 50, cut: 10, removed: 5 },
				],
			},
		]);
		// El KPI del último mes va siempre en moneda de sistema.
		expect(result.totals.counted_last).toBe(150);
	});

	it('moneda de factura: monto asignado en moneda de factura ÷ plazo, agrupado por moneda de factura', async () => {
		const { db, service } = build();
		const result = await service.series(HOLDING, { currency: 'invoice', from: '2025-01', to: '2025-01' });

		expect(amountsSql(db).sql).toContain('m.invoice_currency AS currency');
		expect(amountsSql(db).sql).toContain('SUM(m.allocated_invoice_currency / NULLIF(m.term, 0)) FILTER');
		expect(result.months).toEqual([{ month: '2025-01', counted: null, cut: null, removed: null, contracts: 0, by_currency: [] }]);
		expect(result.currency_mode).toBe('invoice');
	});

	it('filtros: compañía emisora, cliente comercial, razón social receptora (por la factura de origen) y su país', async () => {
		const { db, service } = build();
		const result = await service.series(HOLDING, { companyId: COMPANY, clientId: CLIENT, entityId: ENTITY, country: 'br' });
		const { sql, params } = amountsSql(db);

		expect(sql).toContain(
			'LEFT JOIN invoices_legacy il ON il.id = m.invoice_legacy_id LEFT JOIN client_entities ce ON ce.id = il.client_entity_id'
		);
		expect(sql).toContain(
			'm.company_id = $2::uuid AND m.client_id = $3::uuid AND il.client_entity_id = $4::uuid AND upper(ce.country_code) = $5'
		);
		expect(params).toEqual([HOLDING, COMPANY, CLIENT, ENTITY, 'BR', '2024-11-01', '2025-03-01']);
		// Mismos filtros para los contratos empalmados, las líneas y los límites del rango por defecto.
		expect(db.statements('WITH linked AS')[0].sql).toContain('il.client_entity_id = $4::uuid');
		expect(db.statements('AS lines')[0].sql).toContain('upper(ce.country_code) = $5');
		expect(db.statements('AS first_month, to_char(MAX')[0].params).toEqual([HOLDING, COMPANY, CLIENT, ENTITY, 'BR']);
		expect(result.filters_applied).toEqual({
			currency: 'system',
			companyId: COMPANY,
			clientId: CLIENT,
			entityId: ENTITY,
			country: 'br',
			from: '2024-11',
			to: '2025-03',
		});
	});

	it('sin datos: serie vacía; rango invertido o de más de 120 meses → 400', async () => {
		const empty = build([['AS first_month, to_char(MAX(m.period_month)', () => [{ first_month: null, last_month: null }]]]);

		await expect(empty.service.series(HOLDING, {})).resolves.toMatchObject({
			months: [],
			totals: { last_month: null, counted_last: 0, lines: 0, clients: 0 },
		});
		expect(empty.db.statements('AS counted_system')).toHaveLength(0);
		const { service } = build();

		await expect(service.series(HOLDING, { from: '2025-03', to: '2025-01' })).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.series(HOLDING, { from: '2010-01', to: '2025-01' })).rejects.toBeInstanceOf(BadRequestException);
	});

	it('opciones de filtro: compañías, países de la razón social receptora y monedas de contrato y de factura presentes en el histórico', async () => {
		const { db, service } = build([
			['FROM mrr_legacy m JOIN companies co', () => [{ id: COMPANY, legal_name: 'SimpliRoute SpA' }]],
			['AS country', () => [{ country: 'BR' }, { country: 'CL' }]],
			[
				"'contract' AS kind",
				() => [
					{ kind: 'contract', currency: 'USD' },
					{ kind: 'invoice', currency: 'BRL' },
					{ kind: 'invoice', currency: 'USD' },
				],
			],
		]);

		await expect(service.filterOptions(HOLDING)).resolves.toEqual({
			companies: [{ id: COMPANY, legal_name: 'SimpliRoute SpA' }],
			countries: ['BR', 'CL'],
			currencies: { contract: ['USD'], invoice: ['BRL', 'USD'] },
		});
		expect(db.calls.every((call) => call.params[0] === HOLDING)).toBe(true);
	});
});
