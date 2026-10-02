import { canonicalVat, vatKey, vatMatches, vatSearchVariants, withoutChildContacts } from './partner-vat.util';

describe('partner-vat.util', () => {
	it('canonicalVat: quita puntos y espacios, normaliza guiones tipográficos y pasa a mayúsculas', () => {
		expect(canonicalVat(' 60.509.001–k ')).toBe('60509001-K');
		expect(canonicalVat('pendiente')).toBeNull();
		expect(canonicalVat(false)).toBeNull();
	});

	it('vatKey: solo letras y dígitos', () => {
		expect(vatKey('76.397.190-2')).toBe('763971902');
		expect(vatKey('tve060408jl4')).toBe('TVE060408JL4');
	});

	it('vatSearchVariants: un RUT incluye las formas con guion y con puntos (k y K)', () => {
		const variants = vatSearchVariants('60509001-k');

		expect(variants).toEqual(expect.arrayContaining(['60509001-k', '60509001-K', '60.509.001-K', '60.509.001-k', '60509001K']));
		expect(vatSearchVariants('900895219-0')).toEqual(expect.arrayContaining(['900895219-0', '9008952190']));
	});

	it('vatMatches: misma clave con otro formato, y vat numérico que perdió el cero inicial', () => {
		expect(vatMatches('76.397.190-2', '76397190-2')).toBe(true);
		expect(vatMatches('763971902', '76397190-2')).toBe(true);
		expect(vatMatches(6142406041060, '06142406041060')).toBe(true);
		expect(vatMatches('76397190-3', '76397190-2')).toBe(false);
		expect(vatMatches(false, '76397190-2')).toBe(false);
	});

	it('withoutChildContacts: descarta los contactos cuya empresa también vino en el resultado', () => {
		const rows = [
			{ id: 1, parent_id: false },
			{ id: 2, parent_id: [1, 'Acme SpA'] },
			{ id: 3, parent_id: [99, 'Otra'] },
		];

		expect(withoutChildContacts(rows).map((row) => row.id)).toEqual([1, 3]);
	});
});
