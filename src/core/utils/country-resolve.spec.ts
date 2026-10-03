import { normalizeCountryText, resolveCountryInput } from './country-resolve';

const COUNTRIES = [
	{ code: 'SV', name_es: 'El Salvador', name_en: 'El Salvador' },
	{ code: 'DO', name_es: 'República Dominicana', name_en: 'Dominican Republic' },
	{ code: 'PE', name_es: 'Perú', name_en: 'Peru' },
];
const db = {
	query: jest.fn(async (sql: string, params?: unknown[]) =>
		sql.includes('WHERE code') ? COUNTRIES.filter((c) => c.code === params?.[0]) : COUNTRIES
	),
};

describe('resolveCountryInput (país ISO de clientes y razones sociales, ronda 3)', () => {
	it('normaliza espacio duro, tildes, mayúsculas y puntos', () => {
		expect(normalizeCountryText('El SALVADOR.')).toBe('el salvador');
	});

	it('texto → código por nombre en español/inglés, código o alias; sin calce → null con el texto intacto', async () => {
		await expect(resolveCountryInput(db, { country: 'El Salvador' })).resolves.toEqual({ country: 'El Salvador', country_code: 'SV' });
		await expect(resolveCountryInput(db, { country: 'PERU' })).resolves.toEqual({ country: 'PERU', country_code: 'PE' });
		await expect(resolveCountryInput(db, { country: 'Republica Dominicana' })).resolves.toMatchObject({ country_code: 'DO' });
		await expect(resolveCountryInput(db, { country: 'do' })).resolves.toMatchObject({ country_code: 'DO' });
		await expect(resolveCountryInput(db, { country: 'Atlántida' })).resolves.toEqual({ country: 'Atlántida', country_code: null });
	});

	it('código → nombre en español; inexistente → 400; vacío borra; nada → no se toca', async () => {
		await expect(resolveCountryInput(db, { country_code: 'pe', country: 'cualquiera' })).resolves.toEqual({
			country: 'Perú',
			country_code: 'PE',
		});
		await expect(resolveCountryInput(db, { country_code: 'XX' })).rejects.toThrow('País no reconocido: XX');
		await expect(resolveCountryInput(db, { country_code: '' })).resolves.toEqual({ country: null, country_code: null });
		await expect(resolveCountryInput(db, {})).resolves.toBeUndefined();
	});
});
