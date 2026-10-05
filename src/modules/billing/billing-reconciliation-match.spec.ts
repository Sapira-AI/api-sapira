import {
	differenceOf,
	type EngineContext,
	type EngineInvoice,
	type EngineMovement,
	folioHit,
	folioNumber,
	fxConsistent,
	fxFromAmount,
	fxFromRate,
	jaroWinkler,
	learnAliases,
	movementStateOf,
	normalizeRut,
	normalizeText,
	payerAliasKey,
	persistedMatch,
	planMatch,
	scanFolios,
	significantTokens,
	subsetSums,
	suggestMatches,
	tierOf,
	withoutLegalSuffix,
} from './billing-reconciliation-match';

const ACME = 'client-acme';
const GLOBEX = 'client-globex';

const invoice = (overrides: Partial<EngineInvoice> = {}): EngineInvoice => ({
	id: 'inv-1',
	invoice_number: 'F-1234',
	client_id: ACME,
	client_name: 'Acme',
	client_entity_name: 'Acme Servicios SpA',
	tax_id: '76.086.428-5',
	currency: 'CLP',
	balance: 1_000_000,
	due_date: '2026-09-30',
	contract_id: 'k-1',
	...overrides,
});

const movement = (overrides: Partial<EngineMovement> = {}): EngineMovement => ({
	id: 'mov-1',
	date: '2026-10-01',
	description: 'TRANSF DE OTROS BANCOS',
	reference: null,
	amount: 1_000_000,
	currency: 'CLP',
	remaining: 1_000_000,
	counterparty_tax_id: null,
	...overrides,
});

const ctx = (invoices: EngineInvoice[], overrides: Partial<EngineContext> = {}): EngineContext => ({
	invoices,
	aliases: new Map(),
	recurrentClients: new Set(),
	feeThresholdPct: 1,
	...overrides,
});

describe('Conciliación: normalización', () => {
	it('texto sin acentos ni puntuación; sufijos legales y palabras bancarias fuera; alias = 4 tokens sin dígitos', () => {
		expect(normalizeText('Transf. de Ácme, S.A.')).toBe('TRANSF DE ACME S A');
		expect(withoutLegalSuffix('ACME SERVICIOS S A')).toBe('ACME SERVICIOS');
		expect(withoutLegalSuffix('GLOBEX LTDA')).toBe('GLOBEX');
		expect(significantTokens('TRANSFERENCIA DE ACME SPA 76.086.428-5 CTA CTE 123')).toEqual(['ACME']);
		expect(payerAliasKey('TEF RECIBIDA DESDE INVERSIONES LOS ANDES Y COMPAÑÍA LIMITADA 0012345')).toBe('INVERSIONES ANDES COMPANIA');
		expect(payerAliasKey('TRANSF 123')).toBeNull();
	});

	it('RUT: DV módulo 11, sin puntos ni guion; inválido → null', () => {
		expect(normalizeRut('76.086.428-5')).toBe('760864285');
		expect(normalizeRut('76086428-4')).toBeNull();
		expect(normalizeRut('12.345.678-5')).toBe('123456785');
	});

	it('folios: parte numérica ≥ 3 dígitos; marcados (FACT/F/N°) o número suelto ≥ 4 dígitos; parcial con 3', () => {
		expect(folioNumber('F-001234')).toBe('1234');
		expect(folioNumber('A1')).toBeNull();
		expect(folioHit('F-1234', scanFolios('PAGO FACT 1234 ACME'))).toBe('full');
		expect(folioHit('F-1234', scanFolios('PAGO N° 1234'))).toBe('full');
		expect(folioHit('INV-2024-0077', scanFolios('PAGO INV2024 0077'))).toBe('full');
		expect(folioHit('F-123', scanFolios('PAGO 123 ACME'))).toBe('partial');
		expect(folioHit('F-1234', scanFolios('TRANSF 76.086.428-5'))).toBeNull();
	});

	it('Jaro-Winkler y subset-sum acotado (único vs ambiguo)', () => {
		expect(jaroWinkler('MARTHA', 'MARHTA')).toBeCloseTo(0.961, 2);
		expect(jaroWinkler('ACME', 'ACME')).toBe(1);
		expect(subsetSums([{ amount: 100 }, { amount: 200 }, { amount: 300 }], 500)).toHaveLength(1);
		expect(subsetSums([{ amount: 100 }, { amount: 200 }, { amount: 300 }, { amount: 400 }], 500)).toHaveLength(2);
		expect(subsetSums([{ amount: 100 }], 50)).toEqual([]);
	});

	it('estado del movimiento: ignorado > cargo > conciliado > parcial > pendiente', () => {
		expect(movementStateOf({ status: 'Ignorado', amount: 10 })).toBe('ignored');
		expect(movementStateOf({ status: 'Pendiente', amount: -10 })).toBe('debit');
		expect(movementStateOf({ status: 'Conciliado', amount: 10, applied: 10 })).toBe('reconciled');
		expect(movementStateOf({ status: 'Pendiente', amount: 10, applied: 4 })).toBe('partial');
		expect(movementStateOf({ status: 'Pendiente', amount: 10, applied: 0.001 })).toBe('pending');
	});
});

describe('Conciliación: diferencia con motivo sugerido', () => {
	it('redondeo ≤ 1 unidad, retención ≈ 10/15/20/25/35 %, comisión ≤ umbral; fuera de eso → null', () => {
		expect(differenceOf(999.4, 1000, 'CLP')).toMatchObject({ amount: 0.6, suggested_reason: 'rounding' });
		expect(differenceOf(900, 1000, 'USD')).toMatchObject({ amount: 100, suggested_reason: 'withholding' });
		expect(differenceOf(650, 1000, 'USD')).toMatchObject({ suggested_reason: 'withholding' });
		expect(differenceOf(995_000, 1_000_000, 'CLP')).toMatchObject({ amount: 5000, suggested_reason: 'bank_fee' });
		expect(differenceOf(970_000, 1_000_000, 'CLP', 5)).toMatchObject({ suggested_reason: 'bank_fee' });
		expect(differenceOf(500_000, 1_000_000, 'CLP')).toBeNull();
		expect(differenceOf(1000, 1000, 'CLP')).toBeNull();
	});
});

describe('Conciliación: motor de sugerencias (D1–D4 + F1)', () => {
	it('D1 Exacta: folio en la glosa y monto = saldo (100, razones legibles)', () => {
		const [best] = suggestMatches(
			movement({ description: 'TRANSF PAGO FACT 1234' }),
			ctx([invoice(), invoice({ id: 'inv-2', invoice_number: 'F-999' })])
		);

		expect(best).toMatchObject({ confidence: 'exact', score: 100, shape: 'one_to_one', movement_ids: ['mov-1'], total: 1_000_000 });
		expect(best.allocations).toEqual([expect.objectContaining({ invoice_id: 'inv-1', amount: 1_000_000, contract_id: 'k-1', client_id: ACME })]);
		expect(best.reasons.map((reason) => reason.code)).toEqual(['folio_match', 'amount_exact']);
		expect(best.reasons[0].detail).toContain('F-1234');
	});

	it('D1 Exacta 1-a-muchos: varios folios del mismo cliente que suman el monto', () => {
		const [best] = suggestMatches(
			movement({ description: 'PAGO FACTURAS 1234 1235', amount: 1_500_000, remaining: 1_500_000 }),
			ctx([invoice(), invoice({ id: 'inv-2', invoice_number: 'F-1235', balance: 500_000 })])
		);

		expect(best).toMatchObject({ confidence: 'exact', shape: 'one_to_many', total: 1_500_000 });
		expect(best.allocations.map((allocation) => allocation.invoice_id).sort()).toEqual(['inv-1', 'inv-2']);
	});

	it('D2 Alta: RUT del pagador = tax id y monto = saldo (95); 1-a-muchos único del cliente', () => {
		const invoices = [
			invoice({ invoice_number: 'F-1' }),
			invoice({ id: 'inv-2', invoice_number: 'F-2', balance: 300_000, due_date: '2026-08-31' }),
			invoice({ id: 'inv-3', invoice_number: 'F-3', balance: 450_000 }),
			invoice({ id: 'inv-9', invoice_number: 'F-9', balance: 1_000_000, client_id: GLOBEX, tax_id: '77.111.222-6' }),
		];
		const single = suggestMatches(movement({ counterparty_tax_id: '760864285' }), ctx(invoices));

		expect(single[0]).toMatchObject({ confidence: 'high', score: 95, shape: 'one_to_one' });
		expect(single[0].allocations[0].invoice_id).toBe('inv-1');
		const many = suggestMatches(movement({ counterparty_tax_id: '760864285', amount: 750_000, remaining: 750_000 }), ctx(invoices));

		expect(many[0]).toMatchObject({ confidence: 'high', score: 95, shape: 'one_to_many', total: 750_000 });
		expect(many[0].reasons.map((reason) => reason.code)).toEqual(['tax_id_match', 'subset_sum']);
	});

	it('D3 Alta: alias aprendido del historial → cliente y monto = saldo (92); alias que apunta a dos clientes no se usa', () => {
		const learned = learnAliases([
			{ description: 'TEF DESDE INVERSIONES ROJAS 001', tax_id: null, client_id: ACME },
			{ description: 'TEF DE COMERCIAL SUR', tax_id: null, client_id: ACME },
			{ description: 'TEF DE COMERCIAL SUR', tax_id: null, client_id: GLOBEX },
		]);
		const invoices = [invoice(), invoice({ id: 'inv-2', client_id: GLOBEX, tax_id: null, invoice_number: 'F-77', balance: 1_000_000 })];
		const [best] = suggestMatches(movement({ description: 'TEF DESDE INVERSIONES ROJAS 994' }), ctx(invoices, learned));

		expect(best).toMatchObject({ confidence: 'high', score: 92, shape: 'one_to_one' });
		expect(best.allocations[0].client_id).toBe(ACME);
		expect(learned.aliases.get('A:COMERCIAL SUR')).toBeNull();
	});

	it('D4 Probable: monto = saldo de una sola factura del holding sin identidad (70); si hay dos, no', () => {
		const [best] = suggestMatches(movement(), ctx([invoice({ tax_id: null, client_entity_name: null, due_date: null })]));

		expect(best).toMatchObject({ confidence: 'medium', score: 70, shape: 'one_to_one' });
		expect(
			suggestMatches(
				movement(),
				ctx([invoice({ due_date: null }), invoice({ id: 'inv-2', client_id: GLOBEX, client_name: 'Globex', due_date: null })])
			)
		).toEqual([]);
	});

	it('F1 bajo 60 no se sugiere (Sin identificar)', () => {
		expect(suggestMatches(movement({ amount: 123_456, remaining: 123_456 }), ctx([invoice({ due_date: '2026-01-01' })]))).toEqual([]);
	});

	it('nunca moneda distinta ni facturas de distintos clientes juntas', () => {
		expect(suggestMatches(movement({ description: 'FACT 1234', currency: 'USD' }), ctx([invoice()]))).toEqual([]);
		const mixed = suggestMatches(
			movement({ description: 'PAGO FACTURAS 1234 5678', amount: 1_500_000, remaining: 1_500_000 }),
			ctx([invoice(), invoice({ id: 'inv-2', invoice_number: 'F-5678', balance: 500_000, client_id: GLOBEX, client_name: 'Globex' })])
		);

		expect(mixed.every((entry) => new Set(entry.allocations.map((allocation) => allocation.client_id)).size === 1)).toBe(true);
		expect(mixed.some((entry) => entry.shape === 'one_to_many')).toBe(false);
	});

	it('diferencia dentro del umbral: sugerencia 1-a-1 con difference y motivo; fuera → parcial; sobrepago → asignación = saldo', () => {
		const withholding = suggestMatches(
			movement({ counterparty_tax_id: '760864285', amount: 900_000, remaining: 900_000 }),
			ctx([invoice()], { recurrentClients: new Set([ACME]) })
		);

		expect(withholding[0]).toMatchObject({
			shape: 'one_to_one',
			difference: { amount: 100_000, suggested_reason: 'withholding', currency: 'CLP' },
		});
		expect(withholding[0].allocations[0].amount).toBe(900_000);
		// RUT 35 + parcial 8 + vence a 1 día 10 = 53 → sin sugerencia; con folio en la glosa (+15) = 68 → Probable parcial.
		expect(suggestMatches(movement({ counterparty_tax_id: '760864285', amount: 400_000, remaining: 400_000 }), ctx([invoice()]))).toEqual([]);
		const partial = suggestMatches(
			movement({ counterparty_tax_id: '760864285', description: 'ABONO FACT 1234', amount: 400_000, remaining: 400_000 }),
			ctx([invoice()])
		);

		expect(partial[0]).toMatchObject({ shape: 'partial', confidence: 'medium', score: 68, difference: null });
		expect(partial[0].allocations[0].amount).toBe(400_000);
		const over = suggestMatches(movement({ counterparty_tax_id: '760864285', amount: 1_002_000, remaining: 1_002_000 }), ctx([invoice()]));

		expect(over[0].allocations[0].amount).toBe(1_000_000);
	});

	it('muchos-a-1 (detalle): abonos del mismo pagador a ±10 días que suman el saldo', () => {
		const other = movement({ id: 'mov-2', date: '2026-10-05', amount: 400_000, remaining: 400_000, counterparty_tax_id: '760864285' });
		const result = suggestMatches(movement({ amount: 600_000, remaining: 600_000, counterparty_tax_id: '760864285' }), ctx([invoice()]), [other]);
		const many = result.find((entry) => entry.shape === 'many_to_one');

		expect(many).toMatchObject({ confidence: 'high', movement_ids: ['mov-1', 'mov-2'], total: 1_000_000 });
	});

	it('ordena por nivel y puntaje, deduplica por asignaciones y corta en 5', () => {
		const invoices = Array.from({ length: 8 }, (_, index) =>
			invoice({ id: `inv-${index}`, invoice_number: `F-${100 + index}`, balance: 1_000_000 + index * 1000 })
		);
		const result = suggestMatches(movement({ counterparty_tax_id: '760864285', description: 'FACT 100' }), ctx(invoices));

		expect(result.length).toBeLessThanOrEqual(5);
		expect(result[0].confidence).toBe('exact');
		expect(new Set(result.map((entry) => entry.allocations.map((allocation) => allocation.invoice_id).join())).size).toBe(result.length);
	});

	it('persistencia: exact → high/100, high → high (<100), medium → medium; lectura inversa', () => {
		const [exact] = suggestMatches(movement({ description: 'FACT 1234' }), ctx([invoice()]));

		expect(persistedMatch(exact)).toEqual({ suggested_invoice_id: 'inv-1', match_confidence: 'high', match_score: 100 });
		expect(persistedMatch(null)).toEqual({ suggested_invoice_id: null, match_confidence: null, match_score: null });
		expect(tierOf('high', 100)).toBe('exact');
		expect(tierOf('high', 95)).toBe('high');
		expect(tierOf('medium', 70)).toBe('medium');
		expect(tierOf(null, null)).toBe('none');
	});
});

describe('Conciliación: moneda distinta y validador', () => {
	const rows = [
		{ id: 'mov-1', amount: 1000, currency: 'USD', status: 'Pendiente', applied: 0, date: '2026-10-01' },
		{ id: 'mov-2', amount: 500, currency: 'USD', status: 'Pendiente', applied: 0, date: '2026-10-02' },
	];
	const clp = new Map([
		['inv-1', 'CLP'],
		['inv-2', 'CLP'],
	]);
	const usd = new Map([['inv-1', 'USD']]);

	it('tipo de cambio dado o monto dado; consistencia con tolerancia proporcional a la tasa', () => {
		expect(fxFromRate(1000, 950.5)).toEqual({ original_amount: 1000, fx_rate: 950.5, amount: 950500 });
		expect(fxFromAmount(1000, 950500)).toMatchObject({ fx_rate: 950.5, amount: 950500 });
		expect(fxConsistent(1000, 950.5, 950500)).toBe(true);
		// El front redondea el original a centavos: con tasa 950 el producto se mueve hasta 4,75.
		expect(fxConsistent(105.26, 950, 100_000)).toBe(true);
		expect(fxConsistent(100, 950, 100_000)).toBe(false);
	});

	it('moneda distinta: con tasa → original calculado; con montos originales → tasa derivada; sin nada → fx_required; inconsistente → fx_inconsistent', () => {
		const withRate = planMatch(
			{ movement_ids: ['mov-1'], allocations: [{ invoice_id: 'inv-1', amount: 950_000 }], fx: { rate: 950 } },
			rows,
			clp
		);

		expect(withRate).toMatchObject({ blockers: [], currency: 'USD', invoice_currency: 'CLP', fx_rate: 950, consumption: 1000 });
		expect(withRate.distribution).toEqual([
			{ movement_id: 'mov-1', allocations: [{ invoice_id: 'inv-1', amount: 950_000, original_amount: 1000 }] },
		]);
		expect(withRate.movements[0]).toMatchObject({ applied_after: 1000, remaining_after: 0, state_after: 'reconciled' });
		const withAmount = planMatch(
			{ movement_ids: ['mov-1'], allocations: [{ invoice_id: 'inv-1', amount: 475_000, original_amount: 500 }] },
			rows,
			clp
		);

		expect(withAmount).toMatchObject({ blockers: [], fx_rate: 950, consumption: 500 });
		expect(withAmount.movements[0]).toMatchObject({ remaining_after: 500, state_after: 'partial' });
		expect(
			planMatch({ movement_ids: ['mov-1'], allocations: [{ invoice_id: 'inv-1', amount: 950_000 }] }, rows, clp).blockers.map((b) => b.code)
		).toEqual(['fx_required']);
		expect(
			planMatch(
				{ movement_ids: ['mov-1'], allocations: [{ invoice_id: 'inv-1', amount: 950_000, original_amount: 900 }], fx: { rate: 950 } },
				rows,
				clp
			).blockers.map((b) => b.code)
		).toEqual(['fx_inconsistent']);
	});

	it('bloqueos del movimiento: no encontrado, cargo, ignorado, ya conciliado, monedas mezcladas, sobreaplicado, nota obligatoria', () => {
		const all = [
			...rows,
			{ id: 'debit', amount: -10, currency: 'USD', status: 'Pendiente', applied: 0, date: '2026-10-01' },
			{ id: 'ignored', amount: 10, currency: 'USD', status: 'Ignorado', applied: 0, date: '2026-10-01' },
			{ id: 'done', amount: 10, currency: 'USD', status: 'Conciliado', applied: 10, date: '2026-10-01' },
			{ id: 'eur', amount: 10, currency: 'EUR', status: 'Pendiente', applied: 0, date: '2026-10-01' },
		];
		const codes = (input: Parameters<typeof planMatch>[0]) => planMatch(input, all, usd).blockers.map((blocker) => blocker.code);

		expect(codes({ movement_ids: ['nope'], allocations: [{ invoice_id: 'inv-1', amount: 1 }] })).toContain('movement_not_found');
		expect(codes({ movement_ids: ['debit'], allocations: [{ invoice_id: 'inv-1', amount: 1 }] })).toContain('movement_is_debit');
		expect(codes({ movement_ids: ['ignored'], allocations: [{ invoice_id: 'inv-1', amount: 1 }] })).toContain('movement_not_pending');
		expect(codes({ movement_ids: ['done'], allocations: [{ invoice_id: 'inv-1', amount: 1 }] })).toContain('movement_not_pending');
		expect(codes({ movement_ids: ['mov-1', 'eur'], allocations: [{ invoice_id: 'inv-1', amount: 1 }] })).toContain('movement_currency_mixed');
		expect(codes({ movement_ids: ['mov-1'], allocations: [{ invoice_id: 'inv-1', amount: 1000.02 }] })).toEqual(['movement_overapplied']);
		expect(
			codes({
				movement_ids: ['mov-1'],
				allocations: [{ invoice_id: 'inv-1', amount: 990 }],
				adjustments: [{ invoice_id: 'inv-1', amount: 10, reason: 'other' }],
			})
		).toEqual(['note_required']);
		expect(
			codes({
				movement_ids: ['mov-1'],
				allocations: [{ invoice_id: 'inv-1', amount: 990 }],
				adjustments: [{ invoice_id: 'inv-1', amount: 10, reason: 'bank_fee' }],
			})
		).toEqual([]);
	});

	it('muchos-a-1: reparte el consumo entre movimientos en orden (un register por movimiento); los ajustes no consumen', () => {
		const plan = planMatch(
			{
				movement_ids: ['mov-1', 'mov-2'],
				allocations: [{ invoice_id: 'inv-1', amount: 1400 }],
				adjustments: [{ invoice_id: 'inv-1', amount: 5, reason: 'bank_fee' }],
			},
			rows,
			usd
		);

		expect(plan.blockers).toEqual([]);
		expect(plan.distribution).toEqual([
			{ movement_id: 'mov-1', allocations: [{ invoice_id: 'inv-1', amount: 1000, original_amount: null }] },
			{ movement_id: 'mov-2', allocations: [{ invoice_id: 'inv-1', amount: 400, original_amount: null }] },
		]);
		expect(plan.movements.map((entry) => entry.state_after)).toEqual(['reconciled', 'partial']);
	});
});
