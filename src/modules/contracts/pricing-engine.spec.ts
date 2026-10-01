import {
	baseGlosa,
	describeSingleLine,
	distributeTax,
	isMetered,
	isStandardFixed,
	priceLine,
	type PriceSpec,
	pricingGlosa,
	resolveQuantity,
	splitInvoiceLines,
	tierLabel,
	validatePriceSpec,
} from './pricing-engine';

/** Tramos del benchmark §3.2: 1–5 a 13,00 · 6–10 a 7,00 · 11+ a 5,50, sin cargo fijo. */
const benchmarkTiers = [
	{ from: 1, to: 5, per_unit_amount: 13, flat_amount: 0 },
	{ from: 6, to: 10, per_unit_amount: 7, flat_amount: 0 },
	{ from: 11, to: null, per_unit_amount: 5.5, flat_amount: 0 },
];

/** Precio del mockup 2b/4a (§3.5): tramos con cargo fijo, 100 gratis, mínimo UF 50 y tope UF 80. */
const mockupPrice: PriceSpec = {
	model: 'graduated',
	quantity_type: 'metered',
	billable_metric_id: 'm-rutas',
	tiers: [
		{ from: 1, to: 500, per_unit_amount: 0.08, flat_amount: 10 },
		{ from: 501, to: 2000, per_unit_amount: 0.06, flat_amount: 0 },
		{ from: 2001, to: null, per_unit_amount: 0.045, flat_amount: 0 },
	],
	free_units: 100,
	minimum_amount: 50,
	cap_amount: 80,
};

const amounts = (line: ReturnType<typeof priceLine>) => line.breakdown.map((subline) => [subline.kind, subline.quantity, subline.amount]);

describe('validatePriceSpec (§3.1)', () => {
	it('acepta tramos contiguos que cierran en infinito y los modelos simples', () => {
		expect(validatePriceSpec({ model: 'graduated', quantity_type: 'fixed', tiers: benchmarkTiers })).toEqual([]);
		expect(validatePriceSpec(mockupPrice)).toEqual([]);
		expect(validatePriceSpec({ model: 'package', quantity_type: 'fixed', package_size: 1000, package_amount: 25 })).toEqual([]);
		expect(
			validatePriceSpec({ model: 'seat', quantity_type: 'metered', billable_metric_id: 'm', unit_amount: 12, seat_minimum_quantity: 10 })
		).toEqual([]);
		expect(validatePriceSpec({ model: 'standard', quantity_type: 'fixed' })).toEqual([]);
	});

	it('rechaza huecos, solapes, primer tramo distinto de 1 y último tramo cerrado, con la ruta del campo', () => {
		const fields = (price: PriceSpec) => validatePriceSpec(price).map((error) => error.field);

		expect(
			fields({
				model: 'graduated',
				quantity_type: 'fixed',
				tiers: [
					{ from: 2, to: 5, per_unit_amount: 1, flat_amount: 0 },
					{ from: 7, to: null, per_unit_amount: 1, flat_amount: 0 },
				],
			})
		).toEqual(['tiers[0].from', 'tiers[1].from']);
		expect(
			fields({
				model: 'volume',
				quantity_type: 'fixed',
				tiers: [
					{ from: 1, to: 5, per_unit_amount: 1, flat_amount: 0 },
					{ from: 5, to: 10, per_unit_amount: -1, flat_amount: 0 },
				],
			})
		).toEqual(['tiers[1].from', 'tiers[1].to', 'tiers[1].per_unit_amount']);
		expect(fields({ model: 'graduated', quantity_type: 'fixed', tiers: [] })).toEqual(['tiers']);
		expect(
			validatePriceSpec({ model: 'graduated', quantity_type: 'fixed', tiers: [{ from: 1, to: 5, per_unit_amount: 1, flat_amount: 0 }] })
		).toEqual([{ field: 'tiers[0].to', message: 'El último tramo cierra en infinito (deja "hasta" vacío)' }]);
	});

	it('exige métrica en metered, precio unitario en seat y standard medido, paquete > 0 y tope ≥ mínimo', () => {
		expect(validatePriceSpec({ model: 'standard', quantity_type: 'metered' }).map((error) => error.field)).toEqual([
			'billable_metric_id',
			'unit_amount',
		]);
		expect(validatePriceSpec({ model: 'seat', quantity_type: 'fixed', seat_minimum_quantity: -1 }).map((error) => error.field)).toEqual([
			'unit_amount',
			'seat_minimum_quantity',
		]);
		expect(
			validatePriceSpec({ model: 'package', quantity_type: 'fixed', package_size: 0, package_amount: 0 }).map((error) => error.field)
		).toEqual(['package_size', 'package_amount']);
		expect(
			validatePriceSpec({ model: 'standard', quantity_type: 'fixed', minimum_amount: 100, cap_amount: 50, free_units: -1 }).map((e) => e.field)
		).toEqual(['free_units', 'cap_amount']);
		expect(
			validatePriceSpec({ model: 'standard', quantity_type: 'fixed', billable_metric_id: 'm', tiers: benchmarkTiers }).map((e) => e.field)
		).toEqual(['billable_metric_id', 'tiers']);
		expect(validatePriceSpec({ model: 'percentage' as PriceSpec['model'], quantity_type: 'fixed' })[0].field).toBe('model');
	});
});

describe('priceLine (§3)', () => {
	it('graduated cobra cada tramo a su precio: 12 unidades → 111,00 (benchmark §3.2)', () => {
		const line = priceLine({ model: 'graduated', quantity_type: 'fixed', tiers: benchmarkTiers }, 12, 0);

		expect(line.subtotal).toBe(111);
		expect(amounts(line)).toEqual([
			['tier', 5, 65],
			['tier', 5, 35],
			['tier', 2, 11],
		]);
		expect(line.breakdown.map((subline) => subline.label)).toEqual(['Tramo 1 (1–5)', 'Tramo 2 (6–10)', 'Tramo 3 (11+)']);
		expect(line.effective_unit_price).toBe(9.25);
		expect(line.billable_quantity).toBe(12);
	});

	it('volume cobra todo al tramo alcanzado: 12 unidades → 66,00 (benchmark §3.2)', () => {
		const line = priceLine({ model: 'volume', quantity_type: 'fixed', tiers: benchmarkTiers }, 12, 0);

		expect(line.subtotal).toBe(66);
		expect(amounts(line)).toEqual([['tier', 12, 66]]);
		expect(line.breakdown[0]).toMatchObject({ tier_index: 2, from: 11, to: null, unit_amount: 5.5 });
	});

	it('volume cobra el cargo fijo solo del tramo alcanzado; graduated una vez por tramo con unidades', () => {
		const tiers = [
			{ from: 1, to: 10, per_unit_amount: 1, flat_amount: 100 },
			{ from: 11, to: null, per_unit_amount: 0.5, flat_amount: 20 },
		];

		expect(priceLine({ model: 'volume', quantity_type: 'fixed', tiers }, 12, 0).subtotal).toBe(26);
		expect(priceLine({ model: 'graduated', quantity_type: 'fixed', tiers }, 12, 0).subtotal).toBe(131);
		// Todo dentro del primer tramo: el segundo no aporta ni su cargo fijo.
		expect(priceLine({ model: 'graduated', quantity_type: 'fixed', tiers }, 3, 0).subtotal).toBe(103);
	});

	it('package redondea hacia arriba: 2.350 rutas en bloques de 1.000 a 25,00 → 3 paquetes → 75,00 (§3.3)', () => {
		const price: PriceSpec = { model: 'package', quantity_type: 'metered', billable_metric_id: 'm', package_size: 1000, package_amount: 25 };
		const line = priceLine(price, 2350, 0);

		expect(line.subtotal).toBe(75);
		expect(amounts(line)).toEqual([['package', 3, 75]]);
		expect(line.breakdown[0].label).toBe('3 paquetes de 1.000');
		expect(priceLine(price, 0, 0).subtotal).toBe(0);
		expect(priceLine({ ...price, minimum_amount: 30 }, 0, 0)).toMatchObject({ subtotal: 30, breakdown: [{ kind: 'minimum', amount: 30 }] });
		expect(priceLine(price, 1000, 0).breakdown[0].quantity).toBe(1);
	});

	it('seat cobra max(valor agregado, mínimo): 12,00 × max=11 → 132,00; last=9 con mínimo 10 → 120,00 (§3.4)', () => {
		const price: PriceSpec = { model: 'seat', quantity_type: 'metered', billable_metric_id: 'm', unit_amount: 12, seat_minimum_quantity: 10 };

		expect(priceLine(price, 11, 0)).toMatchObject({
			subtotal: 132,
			billable_quantity: 11,
			breakdown: [{ kind: 'seat', quantity: 11, amount: 132, label: 'Asientos' }],
		});
		expect(priceLine(price, 9, 0)).toMatchObject({
			subtotal: 120,
			quantity: 9,
			billable_quantity: 10,
			breakdown: [{ kind: 'seat', quantity: 10, amount: 120, label: 'Asientos (mínimo 10)' }],
		});
	});

	it('mockup 2b/4a: 1.250 rutas → gratis 100, 400 × 0,08 + 10, 750 × 0,06, −10 % → 78,30 (§3.5)', () => {
		const line = priceLine(mockupPrice, 1250, 10);

		expect(line.subtotal).toBe(78.3);
		expect(amounts(line)).toEqual([
			['free', 100, 0],
			['tier', 400, 42],
			['tier', 750, 45],
			['discount', 0, -8.7],
		]);
		expect(line.breakdown[1]).toMatchObject({ tier_index: 0, from: 1, to: 500, unit_amount: 0.08, flat_amount: 10 });
		expect(line.breakdown[3].label).toBe('Descuento del ítem 10 %');
		expect(line.effective_unit_price).toBe(0.06264);
		expect(line.quantity).toBe(1250);
		expect(line.billable_quantity).toBe(1150);
	});

	it('mockup: 300 rutas → 23,40 y ajuste por mínimo comprometido +26,60 → 50,00 (§3.5)', () => {
		const line = priceLine(mockupPrice, 300, 10);

		expect(line.subtotal).toBe(50);
		expect(amounts(line)).toEqual([
			['free', 100, 0],
			['tier', 200, 26],
			['discount', 0, -2.6],
			['minimum', 0, 26.6],
		]);
	});

	it('mockup: 1.400 rutas → 86,40 y tope máximo −6,40 → 80,00 (§3.5)', () => {
		const line = priceLine(mockupPrice, 1400, 10);

		expect(line.subtotal).toBe(80);
		expect(amounts(line)).toEqual([
			['free', 100, 0],
			['tier', 400, 42],
			['tier', 900, 54],
			['discount', 0, -9.6],
			['cap', 0, -6.4],
		]);
	});

	it('todo el consumo en unidades gratis: sin tramos tarifados ni cargo fijo (0,00; con mínimo, el mínimo) — pregunta 5, default', () => {
		const line = priceLine({ ...mockupPrice, free_units: 500, minimum_amount: null, cap_amount: null }, 300, 10);

		expect(line.subtotal).toBe(0);
		expect(amounts(line)).toEqual([['free', 300, 0]]);
		expect(priceLine({ ...mockupPrice, free_units: 500 }, 300, 10).subtotal).toBe(50);
	});

	it('charge_flat_when_free: 300 rutas con 500 gratis cobran el cargo fijo del primer tramo (10 − 10 % = 9,00); en volumen, el del tramo alcanzado (§3.5)', () => {
		const flat = priceLine({ ...mockupPrice, free_units: 500, minimum_amount: null, cap_amount: null, charge_flat_when_free: true }, 300, 10);

		expect(flat.subtotal).toBe(9);
		expect(flat.billable_quantity).toBe(0);
		expect(amounts(flat)).toEqual([
			['free', 300, 0],
			['tier', 0, 10],
			['discount', 0, -1],
		]);
		expect(flat.breakdown[1]).toMatchObject({ tier_index: 0, flat_amount: 10, label: 'Tramo 1 (1–500) - cargo fijo' });
		// Con mínimo comprometido sigue mandando el mínimo; sin consumo (0) no se cobra nada.
		expect(priceLine({ ...mockupPrice, free_units: 500, charge_flat_when_free: true }, 300, 10).subtotal).toBe(50);
		expect(
			priceLine({ ...mockupPrice, free_units: 500, minimum_amount: null, cap_amount: null, charge_flat_when_free: true }, 0, 10).subtotal
		).toBe(0);
		// Volumen: el tramo lo fija la cantidad total (700 → tramo 2, sin cargo fijo → 0); con un tramo 2 con fijo 5 → 5.
		const volume: PriceSpec = {
			model: 'volume',
			quantity_type: 'fixed',
			free_units: 1000,
			charge_flat_when_free: true,
			tiers: [
				{ from: 1, to: 500, per_unit_amount: 0.08, flat_amount: 10 },
				{ from: 501, to: null, per_unit_amount: 0.06, flat_amount: 5 },
			],
		};

		expect(priceLine(volume, 700, 0).subtotal).toBe(5);
		expect(priceLine({ ...volume, charge_flat_when_free: false }, 700, 0).subtotal).toBe(0);
		// Si el primer tramo no tiene cargo fijo, la bandera no agrega nada.
		expect(
			priceLine(
				{ ...mockupPrice, tiers: benchmarkTiers, free_units: 20, minimum_amount: null, cap_amount: null, charge_flat_when_free: true },
				12,
				0
			).subtotal
		).toBe(0);
	});

	it('valida invoice_line_mode y charge_flat_when_free (solo tramos/volumen)', () => {
		const fields = (price: PriceSpec) => validatePriceSpec(price).map((error) => error.field);

		expect(fields({ ...mockupPrice, invoice_line_mode: 'per_tier', charge_flat_when_free: true })).toEqual([]);
		expect(fields({ ...mockupPrice, invoice_line_mode: 'por_tramo' as never })).toEqual(['invoice_line_mode']);
		expect(fields({ model: 'standard', quantity_type: 'fixed', charge_flat_when_free: true })).toEqual(['charge_flat_when_free']);
		expect(
			fields({ model: 'package', quantity_type: 'fixed', package_size: 10, package_amount: 5, charge_flat_when_free: 'sí' as never })
		).toEqual(['charge_flat_when_free']);
	});

	it('redondea a 2 decimales con el residuo en la última sublínea de tramo: 3 × 1/3 → 0,33 + 0,33 + 0,34 = 1,00 (§3.6)', () => {
		const line = priceLine(
			{
				model: 'graduated',
				quantity_type: 'fixed',
				tiers: [
					{ from: 1, to: 1, per_unit_amount: 1 / 3, flat_amount: 0 },
					{ from: 2, to: 2, per_unit_amount: 1 / 3, flat_amount: 0 },
					{ from: 3, to: null, per_unit_amount: 1 / 3, flat_amount: 0 },
				],
			},
			3,
			0
		);

		expect(line.subtotal).toBe(1);
		expect(line.breakdown.map((subline) => subline.amount)).toEqual([0.33, 0.33, 0.34]);
		// Con descuento después del tramo, el residuo sigue yendo al último tramo, no al descuento.
		const discounted = priceLine({ model: 'standard', quantity_type: 'fixed', unit_amount: 0.005 }, 3, 33.333);

		expect(discounted.subtotal).toBe(0.01);
		// Bruto 0,015 → 0,02 y descuento −0,005 → −0,00 sumarían 0,02: el residuo −0,01 va al tramo, no al descuento.
		expect(discounted.breakdown.map((subline) => [subline.kind, subline.amount])).toEqual([
			['tier', 0.01],
			['discount', 0],
		]);
		expect(discounted.breakdown.reduce((sum, subline) => sum + subline.amount, 0)).toBeCloseTo(0.01, 10);
	});

	it('standard medido: cantidad × precio del período; cantidad 0 → 0,00 y unitario efectivo 0', () => {
		const price: PriceSpec = { model: 'standard', quantity_type: 'metered', billable_metric_id: 'm', unit_amount: 2.5 };

		expect(priceLine(price, 4, 0)).toMatchObject({ subtotal: 10, effective_unit_price: 2.5 });
		expect(priceLine(price, 0, 0)).toMatchObject({ subtotal: 0, effective_unit_price: 0, breakdown: [] });
	});

	it('amount_override: el subtotal es el monto informado, menos el descuento si apply_item_discount; sin tramos, mínimo ni tope', () => {
		const withDiscount = priceLine(mockupPrice, 1250, 10, { amount_override: 100, quantity_source: 'consumption' });

		expect(withDiscount).toMatchObject({ subtotal: 90, quantity: 1250, quantity_source: 'consumption' });
		expect(amounts(withDiscount)).toEqual([
			['tier', 1250, 100],
			['discount', 0, -10],
		]);
		expect(priceLine(mockupPrice, 1250, 10, { amount_override: 100, apply_item_discount: false }).subtotal).toBe(100);
		// Sin tope: 500 supera el cap 80 y se respeta el monto informado.
		expect(priceLine(mockupPrice, 1250, 0, { amount_override: 500 }).subtotal).toBe(500);
	});
});

describe('presentación en la factura (§3.8)', () => {
	it('pricingGlosa: detalle compacto y ASCII con rangos reales (las gratis corren el primer tramo), ajustes y ya facturado', () => {
		expect(pricingGlosa(priceLine(mockupPrice, 1250, 10))).toBe(
			'Tramos: gratis 100; 101-500 x 0,08 + fijo 10,00; 501-1.250 x 0,06; descuento -8,70'
		);
		expect(pricingGlosa(priceLine(mockupPrice, 300, 10))).toBe(
			'Tramos: gratis 100; 101-300 x 0,08 + fijo 10,00; descuento -2,60; minimo comprometido +26,60'
		);
		expect(pricingGlosa(priceLine(mockupPrice, 1400, 10))).toContain('tope -6,40');
		expect(pricingGlosa(priceLine({ model: 'package', quantity_type: 'fixed', package_size: 1000, package_amount: 25 }, 2350, 0))).toBe(
			'Detalle: 3 paquetes x 25,00'
		);
		expect(pricingGlosa(priceLine({ model: 'seat', quantity_type: 'fixed', unit_amount: 12, seat_minimum_quantity: 10 }, 9, 0))).toBe(
			'Detalle: 10 asientos x 12'
		);
		expect(pricingGlosa({ breakdown: [{ kind: 'invoiced', quantity: 1000, amount: -64.8, label: 'Ya facturado en F-1' }] })).toBe(
			'Detalle: ya facturado -64,80'
		);
		expect(pricingGlosa({ breakdown: [] })).toBe('');
		expect(
			pricingGlosa(priceLine({ ...mockupPrice, free_units: 500, minimum_amount: null, cap_amount: null, charge_flat_when_free: true }, 300, 0))
		).toBe('Tramos: gratis 300; cargo fijo 10,00');
	});

	it('describeSingleLine agrega el detalle a la glosa base y baseGlosa lo quita (respeta una glosa editada)', () => {
		const priced = priceLine(mockupPrice, 1250, 10);
		const described = describeSingleLine('Rutas - Periodo 01/10/2026 a 31/10/2026', priced);

		expect(described).toBe(
			'Rutas - Periodo 01/10/2026 a 31/10/2026 - Tramos: gratis 100; 101-500 x 0,08 + fijo 10,00; 501-1.250 x 0,06; descuento -8,70'
		);
		expect(baseGlosa(described)).toBe('Rutas - Periodo 01/10/2026 a 31/10/2026');
		expect(describeSingleLine(described, priceLine(mockupPrice, 300, 10))).toContain('101-300 x 0,08');
		expect(describeSingleLine('Soporte', { breakdown: [] })).toBe('Soporte');
	});

	it('splitInvoiceLines: una fila por tramo (cantidad = unidades, unitario = monto / unidades con el fijo) y una por ajuste (cantidad 1); Σ = subtotal', () => {
		const priced = priceLine(mockupPrice, 1250, 10);
		const parts = splitInvoiceLines(priced);

		expect(parts.map((part) => [part.part, part.quantity, part.unit_price, part.subtotal])).toEqual([
			['charge', 400, 0.105, 42],
			['charge', 750, 0.06, 45],
			['adjustment', 1, -8.7, -8.7],
		]);
		expect(parts.reduce((sum, part) => sum + part.subtotal, 0)).toBeCloseTo(78.3, 10);
		// La primera fila lleva las gratis en su sub-desglose; todas saben la cantidad del período y su posición.
		expect(parts[0].breakdown.map((subline) => subline.kind)).toEqual(['free', 'tier']);
		expect(parts[0].breakdown[1]).toMatchObject({ period_quantity: 1250, line_index: 0, line_count: 3 });
		expect(parts[2].breakdown).toEqual([expect.objectContaining({ kind: 'discount', period_quantity: 1250, line_index: 2, line_count: 3 })]);
		// Mínimo y tope como filas propias (positiva / negativa).
		expect(splitInvoiceLines(priceLine(mockupPrice, 300, 10)).map((part) => [part.label, part.subtotal])).toEqual([
			['Tramo 1 (1–500)', 26],
			['Descuento del ítem 10 %', -2.6],
			['Ajuste por mínimo comprometido', 26.6],
		]);
		expect(splitInvoiceLines(priceLine(mockupPrice, 1400, 10)).at(-1)).toMatchObject({ part: 'adjustment', subtotal: -6.4 });
		// Todo gratis (0,00): una sola fila en 0 con el desglose completo.
		const free = splitInvoiceLines(priceLine({ ...mockupPrice, free_units: 500, minimum_amount: null, cap_amount: null }, 300, 10));

		expect(free).toEqual([expect.objectContaining({ part: 'charge', quantity: 300, unit_price: 0, subtotal: 0, label: 'Unidades gratis' })]);
	});

	it('distributeTax reparte el IVA por fila y deja el residuo en la última fila de cargo', () => {
		expect(distributeTax([42, 45, -8.7], 19, [true, true, false])).toEqual([7.98, 8.55, -1.65]);
		// 0,05 + 0,05 → IVA total round2(0,10 × 19 %) = 0,02; por fila 0,01 + 0,01 = 0,02 (sin residuo); con 0,03 + 0,03: total 0,01, filas 0,01 + 0,01 → residuo −0,01 al último cargo.
		expect(distributeTax([0.03, 0.03], 19, [true, true])).toEqual([0.01, 0]);
		expect(distributeTax([0.03, 0.03, -0.01], 19, [true, true, false])).toEqual([0.01, 0, 0]);
	});
});

describe('resolveQuantity (§3.7)', () => {
	const period = { start: '2026-10-01', end: '2026-10-31' };
	const metered = { quantity: 1000, price: mockupPrice };

	it('fija: la cantidad del ítem', () => {
		expect(resolveQuantity({ quantity: 3, price: null }, period, [{ period_start: '2026-10-01', quantity: 99 }])).toEqual({
			quantity: 3,
			source: 'fixed',
			amount_override: null,
			apply_item_discount: true,
		});
		expect(resolveQuantity({ quantity: 3, price: { model: 'graduated', quantity_type: 'fixed', tiers: benchmarkTiers } }, period).source).toBe(
			'fixed'
		);
	});

	it('medida: el consumo cuyo period_start coincide con el inicio de la línea (real o estimado, con override)', () => {
		expect(
			resolveQuantity(metered, period, [
				{ period_start: '2026-09-01', quantity: 5 },
				{ period_start: '2026-10-01', quantity: 1250, amount_override: 70, apply_item_discount: false },
			])
		).toEqual({ quantity: 1250, source: 'consumption', amount_override: 70, apply_item_discount: false });
		expect(resolveQuantity(metered, period, [{ period_start: '2026-10-01', quantity: 800, is_estimated: true }])).toMatchObject({
			quantity: 800,
			source: 'estimated',
		});
		expect(resolveQuantity(metered, period, [{ period_start: '2026-10-01', quantity: 0 }])).toMatchObject({ quantity: 0, source: 'consumption' });
	});

	it('medida sin consumo: pendiente con la cantidad base del ítem (supuesto, pregunta 3)', () => {
		expect(resolveQuantity(metered, period, [])).toEqual({ quantity: 1000, source: 'pending', amount_override: null, apply_item_discount: true });
	});
});

describe('helpers', () => {
	it('isStandardFixed, isMetered y tierLabel', () => {
		expect(isStandardFixed(null)).toBe(true);
		expect(isStandardFixed({ model: 'standard', quantity_type: 'fixed' })).toBe(true);
		expect(isStandardFixed({ model: 'standard', quantity_type: 'metered', billable_metric_id: 'm', unit_amount: 1 })).toBe(false);
		expect(isMetered(mockupPrice)).toBe(true);
		expect(isMetered(null)).toBe(false);
		expect(tierLabel({ from: 2001, to: null })).toBe('2.001+');
		expect(tierLabel({ from: 501, to: 2000 })).toBe('501–2.000');
	});
});
