import { BadRequestException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { legacyCountedConditions, legacyRemovedSql } from '@/modules/metrics/mrr-historico';
import { fakeDb, Handler } from '@/modules/settings/fake-db.testing-spec';

import { CONCEPT_SQL, groupRows, OnboardingSeriesService } from './onboarding-series.service';

import type { HistorySeriesConcept } from './dtos/onboarding.dto';

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

const amountRow = (month: string, currency: string, values: Partial<Record<string, string>>) => ({
	month,
	currency,
	counted: '0',
	counted_linked: '0',
	counted_not_activated: '0',
	counted_pending: '0',
	after_contract: '0',
	removed: '0',
	counted_system: '0',
	...values,
});
const zero = { counted_linked: 0, counted_not_activated: 0, counted_pending: 0, after_contract: 0, removed: 0 };

describe('serie mensual del MRR histórico (Domi 18-10)', () => {
	it('moneda de sistema: regla U14 única, counted por concepto, histórico después del contrato y quitadas; meses vacíos y devengo', async () => {
		const { db, service } = build(
			[
				[
					'AS counted_system',
					() => [
						amountRow('2025-01', '', {
							counted: '100.004',
							counted_linked: '60',
							counted_not_activated: '30',
							counted_pending: '10.004',
							removed: '7',
							counted_system: '100.004',
						}),
						amountRow('2025-02', '', { counted: '40', counted_pending: '40', after_contract: '60', counted_system: '40' }),
						amountRow('2025-03', '', { after_contract: '100' }),
					],
				],
			],
			'2025-01'
		);
		const result = await service.series(HOLDING, {});
		const { sql } = amountsSql(db);
		const counted = legacyCountedConditions().join(' AND ').replace(/\s+/g, ' ');

		// Una sola regla de qué cuenta (Métricas, Clientes, Cliente 360 y onboarding): recurrente + corte U14 + no quitada.
		expect(sql).toContain(`FILTER (WHERE ${counted}), 0) AS counted,`);
		// Por concepto (Domi 18-10): empalmado, "No activado" (motivo churn, sin interpretar texto) y pendiente; suman counted.
		expect(sql).toContain(`FILTER (WHERE ${counted} AND m.migrated_to_contract_id IS NOT NULL), 0) AS counted_linked`);
		expect(sql).toContain("COALESCE(to_jsonb(m) ->> 'skip_reason_code', 'churn') END) = 'churn'), 0) AS counted_not_activated");
		expect(sql).toContain(`FILTER (WHERE ${counted} AND m.migrated_to_contract_id IS NULL AND NOT m.skip_activation), 0) AS counted_pending`);
		// Solo el histórico posterior al primer mes del contrato se reporta; el mes de empalme (=) no aparece.
		expect(sql).toContain('(f.first_month IS NOT NULL AND m.period_month > f.first_month)), 0) AS after_contract');
		expect(sql).not.toContain('m.period_month = f.first_month');
		expect(sql).toContain('SUM(m.mrr_legacy_system_currency)');
		expect(sql).toContain('COALESCE(m.is_recurring, false) = true');
		expect(db.statements('AS label')).toHaveLength(0);
		expect(result).toEqual({
			currency_mode: 'system',
			system_currency: 'USD',
			// Inicio de la historia del holding (2025-01) posterior al primer dato (2024-11): manda el inicio; hasta el último dato.
			months: [
				{
					month: '2025-01',
					counted: 100,
					counted_linked: 60,
					counted_not_activated: 30,
					counted_pending: 10,
					after_contract: 0,
					removed: 7,
					contracts: 0,
					by_currency: [],
				},
				{ month: '2025-02', ...zero, counted: 40, counted_pending: 40, after_contract: 60, contracts: 80.46, by_currency: [] },
				{ month: '2025-03', ...zero, counted: 0, after_contract: 100, contracts: 200, by_currency: [] },
			],
			rows: [],
			totals: { last_month: '2025-03', counted_last: 0, lines: 4, clients: 2, rows_total: null },
			filters_applied: {
				currency: 'system',
				companyId: null,
				clientId: null,
				entityId: null,
				country: null,
				groupBy: 'none',
				top: null,
				concept: null,
				from: '2025-01',
				to: '2025-03',
			},
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
					amountRow('2025-02', 'CLP', { counted: '90000', counted_linked: '90000', counted_system: '100' }),
					amountRow('2025-02', 'USD', { counted: '50', counted_pending: '50', after_contract: '10', removed: '5', counted_system: '50' }),
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
				counted_linked: null,
				counted_not_activated: null,
				counted_pending: null,
				after_contract: null,
				removed: null,
				contracts: 80.46,
				by_currency: [
					{ currency: 'CLP', ...zero, counted: 90000, counted_linked: 90000 },
					{ currency: 'USD', ...zero, counted: 50, counted_pending: 50, after_contract: 10, removed: 5 },
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
		expect(result.months).toEqual([
			{
				month: '2025-01',
				counted: null,
				counted_linked: null,
				counted_not_activated: null,
				counted_pending: null,
				after_contract: null,
				removed: null,
				contracts: 0,
				by_currency: [],
			},
		]);
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
			groupBy: 'none',
			top: null,
			concept: null,
			from: '2024-11',
			to: '2025-03',
		});
	});

	it('sin datos: serie vacía; rango invertido o de más de 120 meses → 400', async () => {
		const empty = build([['AS first_month, to_char(MAX(m.period_month)', () => [{ first_month: null, last_month: null }]]]);

		await expect(empty.service.series(HOLDING, {})).resolves.toMatchObject({
			months: [],
			rows: [],
			totals: { last_month: null, counted_last: 0, lines: 0, clients: 0, rows_total: null },
		});
		expect(empty.db.statements('AS counted_system')).toHaveLength(0);
		const { service } = build();

		await expect(service.series(HOLDING, { from: '2025-03', to: '2025-01' })).rejects.toBeInstanceOf(BadRequestException);
		await expect(service.series(HOLDING, { from: '2010-01', to: '2025-01' })).rejects.toBeInstanceOf(BadRequestException);
	});

	it('por dimensión (Domi 18-10): solo lo que cuenta, por mes × entidad, con la etiqueta y el JOIN de cada dimensión', async () => {
		const cases = [
			['client', "COALESCE(m.client_id::text, 'none') AS key, MAX(cl.name_commercial) AS label", 'LEFT JOIN clients cl ON cl.id = m.client_id'],
			['entity', "COALESCE(il.client_entity_id::text, 'none') AS key, MAX(ce.legal_name) AS label", 'LEFT JOIN client_entities ce'],
			['product', "COALESCE(NULLIF(btrim(m.product_name), ''), 'none') AS key, MAX(m.product_name) AS label", 'FROM mrr_legacy m'],
			['company', "COALESCE(m.company_id::text, 'none') AS key, MAX(co.legal_name) AS label", 'LEFT JOIN companies co ON co.id = m.company_id'],
		] as const;

		for (const [groupBy, select, join] of cases) {
			const { db, service } = build([
				[
					'AS label',
					() => [
						{ month: '2025-03', key: 'k-1', label: 'Uno', currency: '', counted: '70', counted_system: '70' },
						{ month: '2025-03', key: 'none', label: null, currency: '', counted: '30', counted_system: '30' },
					],
				],
			]);
			const result = await service.series(HOLDING, { groupBy, top: 1, from: '2025-03', to: '2025-03' });
			const [grouped] = db.statements('AS label');

			expect(grouped.sql).toContain(select);
			expect(grouped.sql).toContain(join);
			expect(grouped.sql).toContain(`AND ${legacyCountedConditions().join(' AND ')} GROUP BY 1, 2, 4`.replace(/\s+/g, ' '));
			expect(result.rows).toEqual([
				{ key: 'k-1', label: 'Uno', currency: null, values: [70] },
				{ key: 'others', label: 'Otros', currency: null, values: [30] },
			]);
			expect(result.totals.rows_total).toBe(2);
			expect(result.filters_applied).toMatchObject({ groupBy, top: 1 });
		}
	});

	it('por concepto (Domi 18-10): concept limita counted, counted_system y las filas por dimensión al predicado del concepto; after_contract y removed no', async () => {
		const counted = legacyCountedConditions().join(' AND ');
		const cases: Array<[HistorySeriesConcept, string]> = [
			['linked', 'm.migrated_to_contract_id IS NOT NULL'],
			[
				'not_activated',
				"m.migrated_to_contract_id IS NULL AND (CASE WHEN m.skip_activation THEN COALESCE(to_jsonb(m) ->> 'skip_reason_code', 'churn') END) = 'churn'",
			],
			['pending', 'm.migrated_to_contract_id IS NULL AND NOT m.skip_activation'],
		];

		for (const [concept, predicate] of cases) {
			const { db, service } = build([
				// Primero la consulta por dimensión (también tiene `AS counted_system`).
				['AS label', () => [{ month: '2025-03', key: 'k-1', label: 'Uno', currency: '', counted: '40', counted_system: '40' }]],
				[
					'AS counted_system',
					() => [
						amountRow('2025-03', '', {
							counted: '40',
							[`counted_${concept}`]: '40',
							after_contract: '60',
							removed: '5',
							counted_system: '40',
						}),
					],
				],
			]);
			const result = await service.series(HOLDING, { concept, groupBy: 'client', from: '2025-03', to: '2025-03' });
			const { sql } = amountsSql(db);

			// El mismo predicado que separa los counted_* es el que filtra: counted = counted_<concept> y los otros dos quedan en 0 por SQL.
			expect(CONCEPT_SQL[concept]).toBe(predicate);
			expect(sql).toContain(`FILTER (WHERE ${counted} AND ${predicate}), 0) AS counted,`);
			expect(sql).toContain(`FILTER (WHERE ${counted} AND ${predicate} AND ${CONCEPT_SQL.linked}), 0) AS counted_linked`);
			expect(sql).toContain(`FILTER (WHERE ${counted} AND ${predicate}), 0) AS counted_system`);
			// after_contract y removed se mantienen sin el concepto.
			expect(sql).toContain(
				`FILTER (WHERE NOT ${legacyRemovedSql('m')} AND (f.first_month IS NOT NULL AND m.period_month > f.first_month)), 0) AS after_contract`
			);
			expect(sql).toContain(`FILTER (WHERE ${legacyRemovedSql('m')}), 0) AS removed`);
			// Las filas por dimensión también.
			expect(db.statements('AS label')[0].sql).toContain(`AND ${counted} AND ${predicate} GROUP BY 1, 2, 4`);
			expect(result.months).toEqual([
				{
					month: '2025-03',
					...zero,
					counted: 40,
					[`counted_${concept}`]: 40,
					after_contract: 60,
					removed: 5,
					contracts: 200,
					by_currency: [],
				},
			]);
			expect(result.rows).toEqual([{ key: 'k-1', label: 'Uno', currency: null, values: [40] }]);
			expect(result.totals).toMatchObject({ counted_last: 40, rows_total: 1 });
			expect(result.filters_applied).toMatchObject({ concept, groupBy: 'client' });
		}
		// Sin concept: la regla de siempre, sin predicado extra.
		const { db } = build();

		await new OnboardingSeriesService(db as unknown as DataSource).series(HOLDING, { from: '2025-03', to: '2025-03' });
		expect(amountsSql(db).sql).toContain(`FILTER (WHERE ${counted}), 0) AS counted,`);
	});

	it('filas por dimensión: top por el último mes con datos (desempate por suma), Otros = counted − filas, sin entidad con su etiqueta', () => {
		const months = ['2025-01', '2025-02', '2025-03'];
		const cell = (month: string, key: string, label: string | null, counted: number) => ({
			month,
			key,
			label,
			currency: '',
			counted: String(counted),
			counted_system: String(counted),
		});
		const { rows, total } = groupRows(
			[
				cell('2025-01', 'a', 'Alfa', 500),
				cell('2025-02', 'a', 'Alfa', 10.005),
				cell('2025-02', 'b', 'Beta', 20),
				cell('2025-02', 'c', 'Gama', 20),
				cell('2025-02', 'c', 'Gama', 5),
				cell('2025-02', 'none', null, 1.333),
				cell('2025-02', 'd', 'Delta', 1.333),
				// Fuera del rango: se ignora.
				cell('2024-12', 'z', 'Zeta', 999),
			],
			months,
			'system',
			2,
			'Sin razón social'
		);

		// 2025-03 no tiene datos: manda 2025-02. Gama (25) > Beta (20) > Alfa (10,005; suma mayor pero el último mes manda).
		expect(rows.map((row) => row.key)).toEqual(['c', 'b', 'others']);
		expect(rows[2]).toEqual({ key: 'others', label: 'Otros', currency: null, values: [500, 12.67, 0] });
		// Filas + Otros = counted de cada mes, al centavo.
		const counted = [500, 10.005 + 20 + 25 + 1.333 + 1.333, 0].map((amount) => Math.round(amount * 100) / 100);

		months.forEach((_, position) => {
			expect(Math.round(rows.reduce((sum, row) => sum + row.values[position], 0) * 100) / 100).toBe(counted[position]);
		});
		expect(total).toBe(5);
		const all = groupRows([cell('2025-02', 'none', null, 4), cell('2025-02', 'b', 'Beta', 4)], months, 'system', 15, 'Sin razón social');

		// Sin "Otros" cuando todas caben; empate en el último mes y en la suma → etiqueta.
		expect(all.rows).toEqual([
			{ key: 'b', label: 'Beta', currency: null, values: [0, 4, 0] },
			{ key: 'none', label: 'Sin razón social', currency: null, values: [0, 4, 0] },
		]);
	});

	it('filas por dimensión en moneda de contrato o factura: entidad × moneda, orden por moneda de sistema y un Otros por moneda', () => {
		const { rows, total } = groupRows(
			[
				{ month: '2025-01', key: 'a', label: 'Alfa', currency: 'CLP', counted: '900000', counted_system: '1000' },
				{ month: '2025-01', key: 'a', label: 'Alfa', currency: 'USD', counted: '50', counted_system: '50' },
				{ month: '2025-01', key: 'b', label: 'Beta', currency: 'USD', counted: '200', counted_system: '200' },
				{ month: '2025-01', key: 'c', label: 'Gama', currency: 'CLP', counted: '90000', counted_system: '100' },
			],
			['2025-01'],
			'contract',
			2,
			'Sin cliente'
		);

		expect(rows).toEqual([
			{ key: 'a', label: 'Alfa', currency: 'CLP', values: [900000] },
			{ key: 'b', label: 'Beta', currency: 'USD', values: [200] },
			// Un "Otros" por moneda, en el orden de su primera fila sobrante (Gama CLP 100 USD de sistema > Alfa USD 50).
			{ key: 'others', label: 'Otros', currency: 'CLP', values: [90000] },
			{ key: 'others', label: 'Otros', currency: 'USD', values: [50] },
		]);
		expect(total).toBe(3);
	});

	it('opciones de filtro: compañías, países de la razón social receptora y monedas de contrato y de factura presentes en el histórico', async () => {
		const { db, service } = build([
			['FROM mrr_legacy m JOIN companies co', () => [{ id: COMPANY, legal_name: 'SimpliRoute SpA' }]],
			['AS country', () => [{ country: 'BR' }, { country: 'CL' }]],
			['AS product_name FROM mrr_legacy', () => [{ product_name: 'PATHFINDER+' }]],
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
			products: ['PATHFINDER+'],
		});
		expect(db.calls.every((call) => call.params[0] === HOLDING)).toBe(true);
	});
});
