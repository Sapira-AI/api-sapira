import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { IntegrateFacturaDto } from './sii.dto';

const errorsFor = (body: Record<string, unknown>) => validateSync(plainToInstance(IntegrateFacturaDto, body)).map((error) => error.property);

describe('IntegrateFacturaDto · largos del SII', () => {
	it('acepta giro hasta 80 caracteres y comuna y ciudad hasta 20, y permite omitir el ambiente', () => {
		expect(errorsFor({ business_activity: 'x'.repeat(80), commune: 'y'.repeat(20), city: 'z'.repeat(20) })).toEqual([]);
		expect(errorsFor({})).toEqual([]);
	});

	it('rechaza valores más largos de lo que acepta el SII', () => {
		expect(errorsFor({ business_activity: 'x'.repeat(81), commune: 'y'.repeat(21), city: 'z'.repeat(21) })).toEqual([
			'business_activity',
			'commune',
			'city',
		]);
	});

	it('la dirección del emisor (DirOrigen) acepta hasta 70 caracteres', () => {
		expect(errorsFor({ address: 'x'.repeat(70) })).toEqual([]);
		expect(errorsFor({ address: 'x'.repeat(71) })).toEqual(['address']);
	});

	it('rechaza textos vacíos y ambientes desconocidos', () => {
		expect(errorsFor({ commune: '', environment: 'pruebas' })).toEqual(['commune', 'environment']);
	});
});

describe('IntegrateFacturaDto · actividades económicas (Acteco)', () => {
	it('acepta de 1 a 4 códigos de hasta 6 dígitos', () => {
		expect(errorsFor({ activity_codes: ['620100'] })).toEqual([]);
		expect(errorsFor({ activity_codes: ['620100', '631100', '582000', '1'] })).toEqual([]);
	});

	it('rechaza lista vacía, más de 4 códigos, 0, letras o más de 6 dígitos', () => {
		for (const activity_codes of [[], ['1', '2', '3', '4', '5'], ['0'], ['62A100'], ['6201001'], [620100]]) {
			expect(errorsFor({ activity_codes })).toEqual(['activity_codes']);
		}
	});
});
