/**
 * Filas de un `query()` crudo de TypeORM sobre Postgres, sea cual sea la sentencia.
 *
 * `PostgresQueryRunner.query()` devuelve las filas tal cual para SELECT/INSERT, pero para **UPDATE y DELETE** devuelve
 * `[rows, rowCount]` (`node_modules/typeorm/driver/postgres/PostgresQueryRunner.js`). Leer ese resultado como filas da
 * `length === 2` siempre y `[0]` = el arreglo de filas, no la primera fila. Todo `UPDATE … RETURNING` / `DELETE … RETURNING`
 * se lee con este helper.
 */
export function rowsOf<T = Record<string, unknown>>(result: unknown): T[] {
	if (Array.isArray(result) && Array.isArray(result[0])) return result[0] as T[];
	if (Array.isArray(result)) return result as T[];

	return [];
}
