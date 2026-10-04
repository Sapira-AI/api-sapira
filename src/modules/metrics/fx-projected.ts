import type { DataSource, QueryRunner } from 'typeorm';

type Db = Pick<DataSource, 'query'> | Pick<QueryRunner, 'query'>;
type Row = Record<string, unknown>;

/**
 * Tasa proyectada (decisión de Domi 04-10): sin tasa fija del holding registrada para un mes posterior al mes en curso (y a la última
 * del par), el devengo usa la última tasa registrada extendida hacia adelante (`holding_fixed_fx_rate`, fuente
 * `holding_fixed_period[_inverse]_projected`). Esas filas SÍ suman (no son "Sin tipo de cambio"), pero las lecturas avisan qué monedas y
 * meses van con tasa proyectada y desde qué tasa. Un mes pasado o el actual sin tasa no se proyecta: queda "Sin tipo de cambio".
 */
export interface FxProjected {
	/** Moneda del contrato que se convierte con tasa proyectada. */
	currency: string;
	system_currency: string;
	/** Primer y último mes (YYYY-MM) con tasa proyectada dentro del rango leído. */
	from_month: string;
	to_month: string;
	contracts: number;
	/** Última tasa registrada del par, tal como está guardada en Configuración › Monedas ("1 [to] = rate [from]"). */
	basis: { from_currency: string; to_currency: string; rate: number; period_start: string; period_end: string } | null;
}

/** Fila del RSM convertida al sistema con una tasa fija proyectada. */
export const projectedSourceSql = (alias = 'r') => `COALESCE(${alias}.fx_to_system_source, '') LIKE '%\\_projected'`;

const text = (value: unknown) => (value === null || value === undefined ? '' : String(value));
const isoDate = (value: unknown) => (value instanceof Date ? value.toISOString().slice(0, 10) : text(value).slice(0, 10));

/**
 * Monedas con tasa proyectada en el devengo del holding entre `from` y `to` (primer día de mes; `to` null = sin tope), con la tasa que se
 * está extendiendo. Solo contratos (las suscripciones y el MRR histórico no usan la proyección). Vacío si no hay ninguna.
 */
export async function loadFxProjected(db: Db, holdingId: string, from: string, to: string | null): Promise<FxProjected[]> {
	// Mientras `holding_fixed_fx_rate` no esté aplicada en la base (asset sin aplicar), no hay filas proyectadas que avisar: sin esta guarda
	// la consulta falla al planificarse y tumba el overview de Métricas y el Dashboard.
	// Lleva el holding como $1, como toda consulta del módulo (el spec del Dashboard lo exige).
	const [fn] = (await db.query(
		`SELECT to_regprocedure('public.holding_fixed_fx_rate(uuid, text, text, date)') IS NOT NULL AS ok, $1::uuid AS holding_id`,
		[holdingId]
	)) as Row[];

	if (!fn?.ok) return [];
	const rows = (await db.query(
		`WITH p AS (
			SELECT UPPER(TRIM(c.contract_currency)) AS currency, MIN(r.period_month) AS first_month, MAX(r.period_month) AS last_month,
				COUNT(DISTINCT r.contract_id) AS contracts
			FROM revenue_schedule_monthly r
			JOIN contracts c ON c.id = r.contract_id
			WHERE r.holding_id = $1 AND COALESCE(r.is_total_row, false) = false AND ${projectedSourceSql('r')}
				AND r.period_month >= $2::date AND ($3::date IS NULL OR r.period_month <= $3::date)
			GROUP BY 1
		)
		SELECT p.currency, COALESCE(hs.system_currency, 'USD') AS system_currency, to_char(p.first_month, 'YYYY-MM') AS from_month,
			to_char(p.last_month, 'YYYY-MM') AS to_month, p.contracts,
			h.rate, h.is_inverse, h.period_start, h.period_end
		FROM p
		LEFT JOIN holding_settings hs ON hs.holding_id = $1
		LEFT JOIN LATERAL public.holding_fixed_fx_rate($1::uuid, p.currency, COALESCE(hs.system_currency, 'USD'), p.first_month::date) h ON true
		ORDER BY p.currency`,
		[holdingId, from, to]
	)) as Row[];

	return rows.map((row) => {
		const currency = text(row.currency);
		const system = text(row.system_currency);

		return {
			currency,
			system_currency: system,
			from_month: text(row.from_month),
			to_month: text(row.to_month),
			contracts: Number(row.contracts ?? 0),
			basis:
				row.rate === null || row.rate === undefined
					? null
					: {
							from_currency: row.is_inverse ? system : currency,
							to_currency: row.is_inverse ? currency : system,
							rate: Number(row.rate),
							period_start: isoDate(row.period_start),
							period_end: isoDate(row.period_end),
						},
		};
	});
}
