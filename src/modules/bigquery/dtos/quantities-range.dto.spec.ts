import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { IntegrateQuantitiesDto, QuantitiesRangeDto } from './quantities-range.dto';

describe('QuantitiesRangeDto', () => {
	const validate = (payload: Record<string, unknown>) => validateSync(plainToInstance(QuantitiesRangeDto, payload));

	it('acepta el formato YYYY-MM-DD', () => {
		expect(validate({ from: '2026-07-01', to: '2026-07-31' })).toHaveLength(0);
	});

	it('acepta el body vacío: sin rango se procesa el mes en curso', () => {
		expect(validate({})).toHaveLength(0);
	});

	it('rechaza un ISO 8601 con hora', () => {
		// class-validator's @IsDateString() lo aceptaría; el canal asume fecha simple porque el valor
		// viaja crudo como parámetro DATE a BigQuery y `from > to` se compara lexicográficamente.
		const errors = validate({ from: '2026-07-01T10:30:00Z', to: '2026-07-31' });

		expect(errors).toHaveLength(1);
		expect(errors[0].property).toBe('from');
		expect(Object.values(errors[0].constraints ?? {}).join(' ')).toContain('YYYY-MM-DD');
	});

	it('rechaza formatos ambiguos de fecha', () => {
		for (const invalid of ['01-07-2026', '2026/07/01', '2026-7-1', 'julio 2026']) {
			expect(validate({ from: invalid, to: '2026-07-31' })).not.toHaveLength(0);
		}
	});

	it('el mensaje de error nombra el campo y el formato esperado', () => {
		const errors = validate({ to: '31-07-2026' });

		expect(Object.values(errors[0].constraints ?? {}).join(' ')).toContain('to debe tener formato YYYY-MM-DD');
	});
});

describe('IntegrateQuantitiesDto', () => {
	it('hereda la validación de fechas y acepta retryFailed', () => {
		const ok = validateSync(plainToInstance(IntegrateQuantitiesDto, { from: '2026-07-01', to: '2026-07-31', retryFailed: true }));
		expect(ok).toHaveLength(0);

		const bad = validateSync(plainToInstance(IntegrateQuantitiesDto, { from: '2026-07-01T00:00:00Z', to: '2026-07-31' }));
		expect(bad).not.toHaveLength(0);
	});

	it('rechaza retryFailed que no sea booleano', () => {
		const errors = validateSync(plainToInstance(IntegrateQuantitiesDto, { retryFailed: 'true' }));

		expect(errors[0].property).toBe('retryFailed');
	});
});
