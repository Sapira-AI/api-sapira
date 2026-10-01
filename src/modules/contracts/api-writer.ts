import type { DataSource, QueryRunner } from 'typeorm';

/**
 * Costura `sapira.writer = 'api'` (regla `docs/reglas-desarrollo/logica-en-api-triggers.md`, mapa §1.3/§4).
 *
 * La lógica de negocio vive en la API; Postgres conserva solo los invariantes. Cada trigger legacy de Contratos, Facturas y
 * Cotizaciones empieza con `IF current_setting('sapira.writer', true) = 'api' THEN RETURN …; END IF;`, así que en una
 * transacción v2 no rellena ni pisa nada: la API escribe cada campo explícitamente. Los invariantes (guard de período y
 * validadores de moneda) no leen la marca y siguen corriendo. El front viejo nunca la fija: su comportamiento no cambia.
 *
 * La marca es **local a la transacción** (`is_local = true`): se fija como **primera sentencia** de toda transacción v2 que
 * escribe y muere con su COMMIT/ROLLBACK (no se filtra a otra conexión del pool).
 */
export const API_WRITER_SQL = `SELECT set_config('sapira.writer', 'api', true)`;

/** Fija la marca en la transacción abierta del runner. Llamarla justo después de `startTransaction()`. */
export async function setApiWriter(runner: Pick<QueryRunner, 'query'>): Promise<void> {
	await runner.query(API_WRITER_SQL);
}

/**
 * Transacción v2 de una sola pieza: conecta, abre, fija la marca, ejecuta `work`, confirma (o revierte si falla) y libera.
 * Para escrituras que antes eran una sola sentencia fuera de transacción (la marca local no sobrevive a un autocommit).
 */
export async function withApiWriter<T>(dataSource: Pick<DataSource, 'createQueryRunner'>, work: (runner: QueryRunner) => Promise<T>): Promise<T> {
	const runner = dataSource.createQueryRunner();

	await runner.connect();
	await runner.startTransaction();
	try {
		await setApiWriter(runner);
		const result = await work(runner);

		await runner.commitTransaction();

		return result;
	} catch (error) {
		await runner.rollbackTransaction();
		throw error;
	} finally {
		await runner.release();
	}
}
