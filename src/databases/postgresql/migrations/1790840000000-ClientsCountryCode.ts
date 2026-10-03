import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * M13 · Configuración v2 ronda 3 (decisión de Domi 03-10, autorizado en el módulo cerrado Clientes): **país ISO** en clientes y razones
 * sociales.
 *
 * 1. `clients.country_code` y `client_entities.country_code` `char(2)` NULL con FK a `countries(code)` (`ON DELETE RESTRICT`) e índice.
 *    La API nueva escribe el código **y** sigue escribiendo `country` con el nombre en español (el front actual lee el texto).
 * 2. Backfill desde el texto libre con el mapeo tolerante de M7 (sin tildes ni mayúsculas, espacios duros como espacio, nombre en español
 *    o inglés, código ISO y alias: EEUU/USA, UK, España, República Dominicana, Emiratos Árabes…). `country` no se toca. Lo que no calza
 *    queda NULL y se lista en el log.
 *    Producción al 03-10 (simulado con SELECT): calzan todos los valores con texto; sin país: 679 clientes y 159 razones sociales.
 *
 * Entities `entities/clientes/*` (generadas desde prod): se actualizan junto con `schema:snapshot` después de aplicar en producción.
 * **NO APLICADA** al 03-10.
 */
const CLIENT_COUNTRY_ALIASES: readonly [alias: string, code: string][] = [
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

/** Normalización SQL: espacio duro → espacio, sin tildes, minúsculas, sin puntos y espacios simples (mismo criterio que M7). */
const NORMALIZE_COUNTRY_SQL = (expression: string) =>
	`btrim(regexp_replace(lower(translate(replace(${expression}, chr(160), ' '), 'ÁÉÍÓÚÜÑÇÂÊÔÃÕáéíóúüñçâêôãõ.', 'AEIOUUNCAEOAOaeiouuncaeoao ')), '\\s+', ' ', 'g'))`;

const TABLES = ['clients', 'client_entities'] as const;

export class ClientsCountryCode1790840000000 implements MigrationInterface {
	name = 'ClientsCountryCode1790840000000';

	public async up(queryRunner: QueryRunner): Promise<void> {
		for (const table of TABLES) {
			await queryRunner.query(`ALTER TABLE "${table}" ADD "country_code" character(2)`);
			await queryRunner.query(
				`COMMENT ON COLUMN "${table}"."country_code" IS 'País ISO 3166-1 alfa-2 (FK countries). La API escribe también ${table}.country con el nombre en español'`
			);
			await queryRunner.query(
				`ALTER TABLE "${table}" ADD CONSTRAINT "${table}_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE NO ACTION`
			);
			await queryRunner.query(`CREATE INDEX "idx_${table}_country_code" ON "${table}" ("country_code")`);
			await queryRunner.query(
				`WITH names AS (
					SELECT code, ${NORMALIZE_COUNTRY_SQL('name_es')} AS name FROM countries
					UNION SELECT code, ${NORMALIZE_COUNTRY_SQL('name_en')} FROM countries
					UNION SELECT code, lower(code) FROM countries
					UNION SELECT alias.code, alias.name FROM unnest($1::text[], $2::text[]) AS alias(name, code)
				)
				UPDATE "${table}" t SET country_code = n.code
				FROM names n
				WHERE t.country_code IS NULL AND t.country IS NOT NULL AND ${NORMALIZE_COUNTRY_SQL('t.country')} = n.name`,
				[CLIENT_COUNTRY_ALIASES.map((row) => row[0]), CLIENT_COUNTRY_ALIASES.map((row) => row[1])]
			);
			const unmatched = (await queryRunner.query(
				`SELECT country, count(*) AS n FROM "${table}" WHERE country_code IS NULL AND NULLIF(btrim(country), '') IS NOT NULL GROUP BY country ORDER BY country`
			)) as { country: string; n: string }[];

			if (unmatched?.length) {
				console.warn(
					`[M13] ${table} con país sin calce (country_code queda NULL): ${unmatched.map((row) => `${row.country} (${row.n})`).join(', ')}`
				);
			}
		}
	}

	public async down(queryRunner: QueryRunner): Promise<void> {
		for (const table of TABLES) {
			await queryRunner.query(`DROP INDEX IF EXISTS "idx_${table}_country_code"`);
			await queryRunner.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${table}_country_code_fkey"`);
			await queryRunner.query(`ALTER TABLE "${table}" DROP COLUMN IF EXISTS "country_code"`);
		}
	}
}
