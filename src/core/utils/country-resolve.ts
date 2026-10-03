import { BadRequestException } from '@nestjs/common';

/** Alias frecuentes en texto libre → código (mismos que la migración M13, que tiene su propia copia: las migraciones no importan código). */
export const CLIENT_COUNTRY_ALIASES: readonly [alias: string, code: string][] = [
	['eeuu', 'US'],
	['ee uu', 'US'],
	['usa', 'US'],
	['estados unidos de america', 'US'],
	['united states of america', 'US'],
	['uk', 'GB'],
	['inglaterra', 'GB'],
	['england', 'GB'],
	['espana', 'ES'],
	['corea', 'KR'],
	['republica dominicana', 'DO'],
	['emiratos arabes', 'AE'],
];

/** Normalización (igual que M7/M13 en SQL): espacio duro → espacio, sin tildes, minúsculas, sin puntos y espacios simples. */
export const normalizeCountryText = (value: string): string =>
	value
		.replace(/\u00a0/g, ' ')
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/\./g, ' ')
		.replace(/\s+/g, ' ')
		.trim();

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/**
 * País de un cliente o razón social (Configuración v2 ronda 3, contrato §8.8): con `country_code` (ISO-2) se valida contra `countries`
 * (400 `País no reconocido: XX`) y `country` pasa a ser su nombre en español; con solo `country` (texto, front actual) se busca el código
 * con el mismo mapeo tolerante de la migración M13 (si no calza, el código queda `null` y el texto se respeta). Sin ninguno de los dos →
 * `undefined` (no se toca). `null`/`''` en el campo enviado → los dos `null`.
 */
export async function resolveCountryInput(
	db: Queryable,
	input: { country?: string | null; country_code?: string | null }
): Promise<{ country: string | null; country_code: string | null } | undefined> {
	if (input.country_code !== undefined) {
		const code = (input.country_code ?? '').trim().toUpperCase();

		if (!code) return { country: null, country_code: null };
		const rows = ((await db.query(`SELECT code, name_es FROM countries WHERE code = $1`, [code])) ?? []) as { code?: string; name_es?: string }[];
		const found = rows.find((row) => String(row.code ?? '').trim() === code);

		if (!found) throw new BadRequestException(`País no reconocido: ${code}`);

		return { country: String(found.name_es ?? code), country_code: code };
	}
	if (input.country === undefined) return undefined;
	const text = (input.country ?? '').trim();

	if (!text) return { country: null, country_code: null };
	const wanted = normalizeCountryText(text);
	const alias = CLIENT_COUNTRY_ALIASES.find(([name]) => name === wanted)?.[1];
	const countries = ((await db.query(`SELECT code, name_es, name_en FROM countries`)) ?? []) as {
		code?: string;
		name_es?: string;
		name_en?: string;
	}[];
	const match = countries.find((row) => {
		const code = String(row.code ?? '').trim();

		return (
			/^[A-Z]{2}$/.test(code) &&
			(code === alias ||
				code.toLowerCase() === wanted ||
				normalizeCountryText(String(row.name_es ?? '')) === wanted ||
				normalizeCountryText(String(row.name_en ?? '')) === wanted)
		);
	});

	return { country: text, country_code: match ? String(match.code).trim() : null };
}
