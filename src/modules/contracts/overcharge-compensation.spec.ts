import { oneOffOf, oneOffSubline, withoutOneOff } from './one-off-discount';
import {
	applyCompensation,
	type CompensationInfo,
	compensationLabel,
	compensationMarker,
	compensationNote,
	compensationOf,
	compensationRange,
	isCompensationMarker,
	withoutCompensation,
} from './overcharge-compensation';

const periods = [
	{ invoice_id: 'a', invoice_number: 'A9986', period_start: '2026-09-01', period_end: '2026-09-30', amount: 8778 },
	{ invoice_id: 'b', invoice_number: 'A10089', period_start: '2026-10-01', period_end: '2026-10-31', amount: 8778 },
	{ invoice_id: 'c', invoice_number: 'A10185', period_start: '2026-11-01', period_end: '2026-11-30', amount: 8778 },
];
const info = (overrides: Partial<CompensationInfo> = {}): CompensationInfo => ({
	item_id: 'item-1',
	periods,
	mode: 'quantity',
	base_quantity: 61,
	base_unit_price: 627,
	units: 42,
	amount: 26334,
	count: { quantity: 14, months: 3 },
	...overrides,
});

describe('compensación de un cobro en exceso: no es un descuento (Domi 16-11)', () => {
	describe('applyCompensation', () => {
		it('S07212: 14 licencias de más en 3 meses cubren 42 de las 61 de diciembre → 19 × 627 = 11.913, exacto', () => {
			expect(applyCompensation({ quantity: 61, unit_price: 627, subtotal: 38247 }, 26334, 'quantity')).toEqual({
				quantity: 19,
				unit_price: 627,
				subtotal: 11913,
				amount: 26334,
				units: 42,
			});
		});

		it('el ejemplo de Domi: eran 60, se facturaron 70 → el período siguiente factura 50', () => {
			expect(applyCompensation({ quantity: 60, unit_price: 100, subtotal: 6000 }, 1000, 'quantity')).toMatchObject({
				quantity: 50,
				subtotal: 5000,
				units: 10,
			});
		});

		it('con el descuento del ítem la cuenta sigue en unidades: el neto por unidad ya trae el descuento', () => {
			// 7 × 100 × 0,8 = 560; 240 de más = 3 unidades → 4 × 100 × 0,8 = 320.
			expect(applyCompensation({ quantity: 7, unit_price: 100, subtotal: 560 }, 240, 'quantity')).toEqual({
				quantity: 4,
				unit_price: 100,
				subtotal: 320,
				amount: 240,
				units: 3,
			});
		});

		it('por días: la cantidad queda con decimales (4) y el neto sale de esa cantidad', () => {
			// 14 de más × 17/30 de un período a 627 = 4.974,20 → 7,9333 unidades.
			const result = applyCompensation({ quantity: 61, unit_price: 627, subtotal: 38247 }, 4974.2, 'quantity');

			expect(result.quantity).toBe(53.0667);
			expect(result.units).toBe(7.9333);
			expect(result.subtotal).toBe(Math.round(53.0667 * 627 * 100) / 100);
			// La diferencia con el monto pedido es de centavos.
			expect(Math.abs(result.amount - 4974.2)).toBeLessThan(0.05);
		});

		it('baja de precio: la cantidad no cambia y baja el unitario', () => {
			// 10 × 90 = 900 con 300 de más → 10 × 60 = 600.
			expect(applyCompensation({ quantity: 10, unit_price: 90, subtotal: 900 }, 300, 'unit_price')).toEqual({
				quantity: 10,
				unit_price: 60,
				subtotal: 600,
				amount: 300,
				units: 0,
			});
		});

		it('tope: nunca más que el neto de la línea (queda en 0, nunca negativa); sin monto, la línea no cambia', () => {
			expect(applyCompensation({ quantity: 7, unit_price: 100, subtotal: 700 }, 900, 'quantity')).toEqual({
				quantity: 0,
				unit_price: 100,
				subtotal: 0,
				amount: 700,
				units: 7,
			});
			expect(applyCompensation({ quantity: 10, unit_price: 90, subtotal: 900 }, 900, 'unit_price')).toMatchObject({
				quantity: 10,
				unit_price: 0,
				subtotal: 0,
			});
			expect(applyCompensation({ quantity: 7, unit_price: 100, subtotal: 700 }, 0, 'quantity')).toEqual({
				quantity: 7,
				unit_price: 100,
				subtotal: 700,
				amount: 0,
				units: 0,
			});
		});
	});

	describe('texto y marca', () => {
		it('cantidad: lo del período menos lo ya facturado, con la cuenta entre paréntesis solo cuando es exacta', () => {
			expect(compensationLabel(info())).toBe('61 del período menos 42 ya facturados en sep-nov 2026 (14 x 3)');
			expect(compensationLabel(info({ count: null }))).toBe('61 del período menos 42 ya facturados en sep-nov 2026');
			// La cuenta guardada ya no calza con lo restado (otra compensación se sumó a la línea): sin paréntesis.
			expect(compensationLabel(info({ units: 30 }))).toBe('61 del período menos 30 ya facturados en sep-nov 2026');
			expect(compensationLabel(info({ base_quantity: 61, units: 7.9333, count: null, periods: periods.slice(0, 1) }))).toBe(
				'61 del período menos 7,9333 ya facturados en sep 2026'
			);
		});

		it('precio: el precio del período menos lo ya facturado de más', () => {
			expect(compensationLabel(info({ mode: 'unit_price', base_quantity: 10, base_unit_price: 90, units: 0, amount: 300, count: null }))).toBe(
				'Precio del período 90 menos lo ya facturado de más en sep-nov 2026'
			);
		});

		it('rango de meses de los períodos emitidos', () => {
			expect(compensationRange(periods)).toBe('sep-nov 2026');
			expect(compensationRange(periods.slice(0, 1))).toBe('sep 2026');
			expect(compensationRange([{ period_start: '2025-12-01', period_end: '2026-02-28' }])).toBe('dic 2025-feb 2026');
		});

		it('la marca vale 0 en el desglose (no suma ni resta) y no es un descuento puntual', () => {
			const marker = compensationMarker(info());
			const commercial = oneOffSubline(100, 'cortesía', { type: 'amount', value: 100 }, 0);

			expect(marker).toEqual({
				kind: 'compensation',
				quantity: 0,
				amount: 0,
				label: '61 del período menos 42 ya facturados en sep-nov 2026 (14 x 3)',
				compensation: info(),
			});
			expect(isCompensationMarker(marker)).toBe(true);
			expect(isCompensationMarker(commercial)).toBe(false);
			expect(compensationOf([commercial, marker])).toBe(marker);
			expect(compensationOf([commercial])).toBeNull();
			expect(oneOffOf([marker])).toBeNull();
			// Ninguna de las dos marcas describe el precio de la línea.
			expect(withoutOneOff([marker])).toBeNull();
			expect(withoutCompensation([commercial, marker])).toEqual([commercial]);
			expect(withoutCompensation([marker])).toBeNull();
		});

		it('la nota de la glosa es el mismo texto, sin tildes', () => {
			expect(compensationNote([compensationMarker(info())])).toBe('61 del periodo menos 42 ya facturados en sep-nov 2026 (14 x 3)');
			expect(compensationNote([oneOffSubline(100, null, { type: 'amount', value: 100 }, 0)])).toBeNull();
			expect(compensationNote(null)).toBeNull();
		});
	});
});
