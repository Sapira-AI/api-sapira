import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CreateClientEntityDto, UpdateClientEntityDto } from './client-directory.dto';

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

describe('Create/UpdateClientEntityDto · commune', () => {
	const base = { client_id: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6', legal_name: 'Norte SpA', tax_id: '76543210-K', country: 'Chile' };
	const createErrors = (body: Record<string, unknown>) =>
		validateSync(plainToInstance(CreateClientEntityDto, { ...base, ...body })).map((error) => error.property);

	it('acepta una comuna de hasta 20 caracteres (CmnaRecep del DTE) y permite omitirla', () => {
		expect(errorsFor({ commune: 'Pedro Aguirre Cerda' })).toEqual([]);
		expect(createErrors({ commune: 'Las Condes' })).toEqual([]);
		expect(createErrors({})).toEqual([]);
	});

	it('rechaza una comuna de más de 20 caracteres', () => {
		expect(errorsFor({ commune: 'x'.repeat(21) })).toEqual(['commune']);
		expect(createErrors({ commune: 'x'.repeat(21) })).toEqual(['commune']);
	});
});
