import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { UpdateClientEntityDto } from './client-directory.dto';

const errorsFor = (body: Record<string, unknown>) => validateSync(plainToInstance(UpdateClientEntityDto, body)).map((error) => error.property);

describe('UpdateClientEntityDto · payment_terms', () => {
	it('acepta las tres formas y null', () => {
		expect(errorsFor({ payment_terms: { kind: 'net', days: 30 } })).toEqual([]);
		expect(errorsFor({ payment_terms: { kind: 'end_of_month', days: 0 } })).toEqual([]);
		expect(errorsFor({ payment_terms: { kind: 'day_of_next_month', day: 17 } })).toEqual([]);
		expect(errorsFor({ payment_terms: null })).toEqual([]);
	});

	it('rechaza tipo desconocido, días fuera de rango o sin el campo que exige su tipo', () => {
		for (const payment_terms of [
			{ kind: 'otro', days: 30 },
			{ kind: 'net', days: 400 },
			{ kind: 'net' },
			{ kind: 'day_of_next_month', day: 0 },
			{ kind: 'day_of_next_month', days: 17 },
		]) {
			expect(errorsFor({ payment_terms })).toEqual(['payment_terms']);
		}
	});
});
