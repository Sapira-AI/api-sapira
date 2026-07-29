import { normalizeTaxId } from './salesforce-transformers';

describe('normalizeTaxId', () => {
	it.each(['pendiente', 'PENDIENTE', 'PeNdIeNtE', ' pen.d i e n t e '])(
		'trata "%s" como un identificador fiscal ausente',
		(value) => {
			expect(normalizeTaxId(value)).toBeNull();
		}
	);

	it('normaliza un RUT válido sin eliminar separadores significativos', () => {
		expect(normalizeTaxId('76.517.784 - 7')).toBe('76517784-7');
	});
});
