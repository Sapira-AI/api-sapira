import { isoToCountryName, normalizeTaxId } from './salesforce-transformers';

describe('normalizeTaxId', () => {
	it.each(['pendiente', 'PENDIENTE', 'PeNdIeNtE', ' pen.d i e n t e '])('trata "%s" como un identificador fiscal ausente', (value) => {
		expect(normalizeTaxId(value)).toBeNull();
	});

	it('normaliza un RUT válido sin eliminar separadores significativos', () => {
		expect(normalizeTaxId('76.517.784 - 7')).toBe('76517784-7');
	});

	it.each([
		['RUT76771924-8', '76771924-8'],
		['RUT: 76.771.924-8', '76771924-8'],
		['R.U.T. 76.771.924-8', '76771924-8'],
		['rut 7.654.321-k', '7654321-k'],
	])('quita el prefijo de "%s" (caso real del CRM)', (value, expected) => {
		expect(normalizeTaxId(value)).toBe(expected);
	});

	it('no recorta identificadores que empiezan con esas letras y no son RUT (RFC)', () => {
		expect(normalizeTaxId('RUT850101AB1')).toBe('RUT850101AB1');
		expect(normalizeTaxId('RUTA800101XY2')).toBe('RUTA800101XY2');
	});
});

describe('isoToCountryName', () => {
	it.each([
		['cl', 'Chile'],
		['DE', 'Alemania'],
		['VG', 'Islas Vírgenes Británicas'],
		['ZW', 'Zimbabue'],
	])('convierte el código ISO %s a %s', (isoCode, expectedCountry) => {
		expect(isoToCountryName(isoCode)).toBe(expectedCountry);
	});

	it('conserva los códigos que no están en el catálogo', () => {
		expect(isoToCountryName('XX')).toBe('XX');
	});
});
