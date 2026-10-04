import { MigrationInterface, QueryRunner } from 'typeorm';

import { BACKUP_SCHEMA, CREATE_BACKUP_SCHEMA_SQL } from '../backups';

/**
 * Limpieza de `exchange_rates_monthly_avg` (04-10-2026, decisión de Domi, "parte del rebuild"; análisis en
 * `docs/v2-rediseno/analisis-fx-y-mrr-historico.md` §4.3 y `src/modules/banco-central/README.md`).
 *
 * 1. **Borra las filas cargadas a mano**: `data_points = 1`, hasta dic-2027, sin ninguna tasa diaria de una fuente diaria (Banco Central,
 *    Perú API) detrás en ese par y mes. Son las proyecciones planas del 14-09 (nov-2026 → dic-2027: CLF/CLP 40.890,98, USD/CLP 933,921,
 *    CLF/USD, CLP/USD, COP/USD, MXN/USD, PEN/USD y cruces a CLP) y la carga única de `exchangerate-api` del 02-01-2026 (cruces de
 *    ene-2026), con ARS/USD = 1.452,25 y BRL/USD = 5,0 / 5,48 invertidas (también UYU/USD = 39,06 y GBP/USD = 0,743). En producción
 *    (lectura del 04-10): **319 filas** de 54 pares, 182 de meses futuros; firma md5 `f2f6462b6a04c070bb06e0440eb81146`
 *    (`from||to||year-month:avg_rate`, ordenadas). Ningún código versionado las escribe.
 * 1 bis. **Borra las filas inversas sin tasas propias** (aprobado por Domi 04-10): par inverso de uno con tasas diarias de una fuente diaria
 *    en ese mes y sin ninguna fila del par en `exchange_rates` (`INVERSE_ROWS_SQL`): CLP/USD, COP/USD, MXN/USD, PEN/USD ene-2025 → abr-2026
 *    y EUR/USD 2025, **76 filas** en producción (lectura del 04-10). Los lectores caen a la inversa de la fila directa.
 *    **Total a borrar (1 + 1 bis): 395 filas**, firma md5 `f491fa7fd2e695b3aba85d05ac45bd8b` (misma firma, verificada en producción).
 * 2. **Recalcula los promedios de los meses terminados** (ene-2025 → sep-2026, nunca el mes en curso de America/Santiago) desde
 *    `exchange_rates` con la regla corregida (`src/modules/banco-central/monthly-average.ts`, aquí congelada al 04-10): todas las fuentes
 *    diarias, una tasa por par y día (prioridad de fuente y, a igual fuente, la más reciente), solo días hábiles para todas las monedas.
 *    Actualiza las filas existentes y crea las que falten **solo si el mes está completo** (días hábiles − 3 tasas y la última a ≤ 3 días
 *    del último hábil, como `isMonthComplete` del cierre); en la copia quedan fuera oct-2025 de USD/ARG, USD/BRL y USD/UYU (8 de 23 días,
 *    hueco del cambio de sistema). `calculated_at = now()`: quedan **cerrados** (mes terminado y `data_points > 1`).
 *    **No vuelve a crear filas inversas**: solo arma par-mes desde las tasas diarias de ese mismo par, y una fila inversa borrada no tiene
 *    ninguna (es la condición del borrado).
 *
 * El recálculo vive en SQL, así que va en la migración (no hace falta el endpoint). Después, el devengo en moneda de compañía de esos
 * meses se pone al día con el rebuild por holding o con `revenue_schedule_apply_fx_for_contract` (procedimiento:
 * `docs/v2-rediseno/rebuild-devengo-comparacion.md` §7).
 *
 * **Respaldo**: `<BACKUP_SCHEMA>.exchange_rates_monthly_avg_1791500000000` (`../backups.ts`, la misma constante que
 * `1791200000000`; fuera de `public`, RLS sin policies) con la fila anterior completa (`deleted`, `deleted_inverse`, `updated`) o la marca de fila nueva
 * (`inserted`), más los valores nuevos. `down()` deshace solo lo que sigue con los valores de esta migración y borra el respaldo si no
 * queda nada pendiente.
 *
 * Idempotente: el borrado no vuelve a encontrar filas, el recálculo da lo mismo y el respaldo conserva el primer valor.
 */

const BACKUP_TABLE = `${BACKUP_SCHEMA}.exchange_rates_monthly_avg_1791500000000`;
const TIMEZONE = 'America/Santiago';
const RECALC_FROM = '2025-01-01';
/** Último mes recalculado: sep-2026, o el anterior al mes en curso si la migración corriera antes (nunca un mes sin terminar). */
const RECALC_TO_SQL = `LEAST('2026-10-01'::date, date_trunc('month', now() AT TIME ZONE '${TIMEZONE}')::date)`;
const DAILY_SOURCES = `'PERU_API', 'BANCOCENTRAL', 'BANCOCENTRALCHILE'`;
const HOLGURA = 3;

/** Filas a borrar: cargadas a mano (una sola tasa) y sin tasas diarias de una fuente diaria detrás, hasta dic-2027. */
const MANUAL_ROWS_SQL = `
	ma.data_points = 1 AND make_date(ma.year, ma.month, 1) <= '2027-12-01'
	AND NOT EXISTS (
		SELECT 1 FROM exchange_rates er
		WHERE er.from_currency = ma.from_currency AND er.to_currency = ma.to_currency
			AND er.rate_date >= make_date(ma.year, ma.month, 1) AND er.rate_date < (make_date(ma.year, ma.month, 1) + interval '1 month')
			AND er.source_type IN (${DAILY_SOURCES})
	)`;

/** Sin ninguna tasa en `exchange_rates` del par de la fila (alias `ma`) en su mes, de ninguna fuente. */
const NO_OWN_DAILY_SQL = `NOT EXISTS (
		SELECT 1 FROM exchange_rates er
		WHERE er.from_currency = ma.from_currency AND er.to_currency = ma.to_currency
			AND er.rate_date >= make_date(ma.year, ma.month, 1) AND er.rate_date < (make_date(ma.year, ma.month, 1) + interval '1 month')
	)`;

/**
 * Filas inversas a borrar (aprobado por Domi 04-10): par inverso de uno que sí tiene tasas diarias de una fuente diaria en ese mes, y sin
 * ninguna tasa propia en `exchange_rates`. Son promedios calculados a mano el 14-04-2026 (CLP/USD, COP/USD, MXN/USD, PEN/USD ene-2025 →
 * abr-2026 y EUR/USD 2025, `data_points` 11–31) que difieren hasta 1 % de 1 ÷ el promedio directo recalculado. Sin ellas, todos los
 * lectores (`calculate_system_fx_rate`, `revenue_schedule_apply_fx_for_contract`, `settings-holding.service`,
 * `calculate_mrr_legacy_system_currency`, `fx_rate`) usan la inversa de la fila directa.
 */
const INVERSE_ROWS_SQL = `
	ma.data_points > 1
	AND ${NO_OWN_DAILY_SQL}
	AND EXISTS (
		SELECT 1 FROM exchange_rates er
		WHERE er.from_currency = ma.to_currency AND er.to_currency = ma.from_currency
			AND er.rate_date >= make_date(ma.year, ma.month, 1) AND er.rate_date < (make_date(ma.year, ma.month, 1) + interval '1 month')
			AND er.source_type IN (${DAILY_SOURCES})
	)`;

/**
 * Promedios recalculados de los meses terminados (regla de `monthly-average.ts` al 04-10, congelada) y si el mes está completo. Columnas:
 * from_currency, to_currency, year, month, avg_rate, min_rate, max_rate, data_points, complete.
 */
const RECALC_SQL = `
	WITH daily AS (
		SELECT DISTINCT ON (er.from_currency, er.to_currency, er.rate_date)
			er.from_currency, er.to_currency, er.rate_date, er.rate
		FROM exchange_rates er
		WHERE er.rate_date >= '${RECALC_FROM}'::date AND er.rate_date < ${RECALC_TO_SQL}
			AND er.rate > 0
			AND er.source_type IN (${DAILY_SOURCES})
			AND EXTRACT(ISODOW FROM er.rate_date) < 6
		ORDER BY er.from_currency, er.to_currency, er.rate_date,
			(CASE
				WHEN er.source_type = 'PERU_API' THEN CASE WHEN er.from_currency = 'USD' AND er.to_currency = 'PEN' THEN 0 ELSE 3 END
				WHEN er.source_type = 'BANCOCENTRAL' THEN 1
				WHEN er.source_type = 'BANCOCENTRALCHILE' THEN 2
				ELSE 9 END),
			er.created_at DESC
	), monthly AS (
		SELECT from_currency, to_currency, EXTRACT(YEAR FROM rate_date)::int AS year, EXTRACT(MONTH FROM rate_date)::int AS month,
			AVG(rate) AS avg_rate, MIN(rate) AS min_rate, MAX(rate) AS max_rate, COUNT(*)::int AS data_points, MAX(rate_date) AS last_date
		FROM daily
		GROUP BY 1, 2, 3, 4
	)
	SELECT m.from_currency, m.to_currency, m.year, m.month, m.avg_rate, m.min_rate, m.max_rate, m.data_points,
		(m.data_points >= GREATEST(1, w.weekdays - ${HOLGURA}) AND m.last_date >= w.last_weekday - ${HOLGURA}) AS complete
	FROM monthly m
	CROSS JOIN LATERAL (
		SELECT COUNT(*)::int AS weekdays, MAX(d)::date AS last_weekday
		FROM generate_series(make_date(m.year, m.month, 1), make_date(m.year, m.month, 1) + interval '1 month' - interval '1 day', interval '1 day') d
		WHERE EXTRACT(ISODOW FROM d) < 6
	) w`;

export class LimpiaPromediosMensualesManuales1791500000000 implements MigrationInterface {
	name = 'LimpiaPromediosMensualesManuales1791500000000';
	// Todo export de una migración debe ser su clase (schema-status.spec): lo que usan los tests se expone como estático.
	static readonly BACKUP_TABLE = BACKUP_TABLE;
	static readonly MANUAL_ROWS_SQL = MANUAL_ROWS_SQL;
	static readonly INVERSE_ROWS_SQL = INVERSE_ROWS_SQL;
	static readonly RECALC_SQL = RECALC_SQL;

	public async up(queryRunner: QueryRunner): Promise<void> {
		for (const sql of CREATE_BACKUP_SCHEMA_SQL) await queryRunner.query(sql);
		await queryRunner.query(
			`CREATE TABLE IF NOT EXISTS ${BACKUP_TABLE} (
				from_currency text NOT NULL,
				to_currency text NOT NULL,
				year integer NOT NULL,
				month integer NOT NULL,
				action text NOT NULL,
				old_id uuid, old_avg_rate numeric, old_min_rate numeric, old_max_rate numeric, old_data_points integer, old_calculated_at timestamptz,
				new_avg_rate numeric, new_data_points integer, new_calculated_at timestamptz,
				backed_up_at timestamptz NOT NULL DEFAULT now(),
				PRIMARY KEY (from_currency, to_currency, year, month)
			)`
		);
		// Sin policies: con RLS activo, solo el dueño (la conexión de migraciones) la lee.
		await queryRunner.query(`ALTER TABLE ${BACKUP_TABLE} ENABLE ROW LEVEL SECURITY`);

		// 1 · Borrado de las filas a mano, con su respaldo.
		await queryRunner.query(
			`WITH gone AS (DELETE FROM exchange_rates_monthly_avg ma WHERE ${MANUAL_ROWS_SQL} RETURNING ma.*)
			INSERT INTO ${BACKUP_TABLE} (from_currency, to_currency, year, month, action, old_id, old_avg_rate, old_min_rate, old_max_rate,
				old_data_points, old_calculated_at)
			SELECT from_currency, to_currency, year, month, 'deleted', id, avg_rate, min_rate, max_rate, data_points, calculated_at FROM gone
			ON CONFLICT (from_currency, to_currency, year, month) DO NOTHING`
		);

		// 1 bis · Borrado de las filas inversas sin tasas propias (Domi 04-10), con su respaldo.
		await queryRunner.query(
			`WITH gone AS (DELETE FROM exchange_rates_monthly_avg ma WHERE ${INVERSE_ROWS_SQL} RETURNING ma.*)
			INSERT INTO ${BACKUP_TABLE} (from_currency, to_currency, year, month, action, old_id, old_avg_rate, old_min_rate, old_max_rate,
				old_data_points, old_calculated_at)
			SELECT from_currency, to_currency, year, month, 'deleted_inverse', id, avg_rate, min_rate, max_rate, data_points, calculated_at FROM gone
			ON CONFLICT (from_currency, to_currency, year, month) DO NOTHING`
		);

		// 2 · Recálculo de los meses terminados: respaldo de la fila anterior (o marca de nueva) y upsert, en una sola sentencia.
		await queryRunner.query(
			`WITH calc AS (${RECALC_SQL}),
			target AS (
				SELECT c.*, ma.id AS old_id, ma.avg_rate AS old_avg_rate, ma.min_rate AS old_min_rate, ma.max_rate AS old_max_rate,
					ma.data_points AS old_data_points, ma.calculated_at AS old_calculated_at
				FROM calc c
				LEFT JOIN exchange_rates_monthly_avg ma
					ON ma.from_currency = c.from_currency AND ma.to_currency = c.to_currency AND ma.year = c.year AND ma.month = c.month
				WHERE ma.id IS NOT NULL OR c.complete
			),
			backup AS (
				INSERT INTO ${BACKUP_TABLE} (from_currency, to_currency, year, month, action, old_id, old_avg_rate, old_min_rate, old_max_rate,
					old_data_points, old_calculated_at, new_avg_rate, new_data_points, new_calculated_at)
				SELECT from_currency, to_currency, year, month, CASE WHEN old_id IS NULL THEN 'inserted' ELSE 'updated' END, old_id, old_avg_rate,
					old_min_rate, old_max_rate, old_data_points, old_calculated_at, avg_rate, data_points, now()
				FROM target
				ON CONFLICT (from_currency, to_currency, year, month) DO UPDATE
					SET new_avg_rate = EXCLUDED.new_avg_rate, new_data_points = EXCLUDED.new_data_points, new_calculated_at = EXCLUDED.new_calculated_at
			)
			INSERT INTO exchange_rates_monthly_avg (from_currency, to_currency, year, month, avg_rate, min_rate, max_rate, data_points, calculated_at)
			SELECT from_currency, to_currency, year, month, avg_rate, min_rate, max_rate, data_points, now() FROM target
			ON CONFLICT (from_currency, to_currency, year, month) DO UPDATE SET avg_rate = EXCLUDED.avg_rate, min_rate = EXCLUDED.min_rate,
				max_rate = EXCLUDED.max_rate, data_points = EXCLUDED.data_points, calculated_at = EXCLUDED.calculated_at`
		);
	}

	/** Deshace solo lo que sigue con los valores de esta migración; el resto queda en el respaldo para revisarlo a mano. */
	public async down(queryRunner: QueryRunner): Promise<void> {
		const [exists] = (await queryRunner.query(`SELECT to_regclass('${BACKUP_TABLE}') IS NOT NULL AS present`)) as Array<{ present: boolean }>;

		if (!exists?.present) return;
		const same = `ma.from_currency = b.from_currency AND ma.to_currency = b.to_currency AND ma.year = b.year AND ma.month = b.month
			AND ma.avg_rate IS NOT DISTINCT FROM b.new_avg_rate AND ma.calculated_at IS NOT DISTINCT FROM b.new_calculated_at`;

		// Filas nuevas: se borran.
		await queryRunner.query(
			`WITH undone AS (
				DELETE FROM exchange_rates_monthly_avg ma USING ${BACKUP_TABLE} b WHERE b.action = 'inserted' AND ${same}
				RETURNING ma.from_currency, ma.to_currency, ma.year, ma.month
			)
			DELETE FROM ${BACKUP_TABLE} b USING undone u
			WHERE b.from_currency = u.from_currency AND b.to_currency = u.to_currency AND b.year = u.year AND b.month = u.month`
		);
		// Filas recalculadas: vuelven a sus valores anteriores.
		await queryRunner.query(
			`WITH undone AS (
				UPDATE exchange_rates_monthly_avg ma SET avg_rate = b.old_avg_rate, min_rate = b.old_min_rate, max_rate = b.old_max_rate,
					data_points = b.old_data_points, calculated_at = b.old_calculated_at
				FROM ${BACKUP_TABLE} b WHERE b.action = 'updated' AND ${same}
				RETURNING ma.from_currency, ma.to_currency, ma.year, ma.month
			)
			DELETE FROM ${BACKUP_TABLE} b USING undone u
			WHERE b.from_currency = u.from_currency AND b.to_currency = u.to_currency AND b.year = u.year AND b.month = u.month`
		);
		// Filas borradas: vuelven con su id (si nadie volvió a crear ese par y mes).
		await queryRunner.query(
			`WITH undone AS (
				INSERT INTO exchange_rates_monthly_avg (id, from_currency, to_currency, year, month, avg_rate, min_rate, max_rate, data_points, calculated_at)
				SELECT b.old_id, b.from_currency, b.to_currency, b.year, b.month, b.old_avg_rate, b.old_min_rate, b.old_max_rate, b.old_data_points,
					b.old_calculated_at
				FROM ${BACKUP_TABLE} b WHERE b.action IN ('deleted', 'deleted_inverse')
				ON CONFLICT (from_currency, to_currency, year, month) DO NOTHING
				RETURNING from_currency, to_currency, year, month
			)
			DELETE FROM ${BACKUP_TABLE} b USING undone u
			WHERE b.from_currency = u.from_currency AND b.to_currency = u.to_currency AND b.year = u.year AND b.month = u.month`
		);
		const [left] = (await queryRunner.query(`SELECT count(*)::int AS n FROM ${BACKUP_TABLE}`)) as Array<{ n: number }>;

		if (Number(left?.n ?? 0) === 0) {
			await queryRunner.query(`DROP TABLE ${BACKUP_TABLE}`);
			await queryRunner.query(
				`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = '${BACKUP_SCHEMA}'::regnamespace) THEN DROP SCHEMA ${BACKUP_SCHEMA}; END IF; END $$`
			);
		}
	}
}
