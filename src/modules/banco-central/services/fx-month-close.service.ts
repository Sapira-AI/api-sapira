import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { withApiWriter } from '@/modules/contracts/api-writer';
import { NotificationsService } from '@/modules/notifications/notifications.service';

import {
	addMonths,
	FX_MONTH_CLOSE_JOB,
	FX_MONTH_CLOSE_LOOKBACK_MONTHS,
	FX_MONTH_CLOSE_TIMEZONE,
	type FxMonthCloseHoldingResult,
	fxMonthCloseKey,
	type FxMonthCloseResult,
	isMonthComplete,
	monthStartIn,
	type PairDailyCoverage,
} from '../fx-month-close';
import { MONTHLY_AVG_DAILY_RATES_SQL } from '../monthly-average';

import { FX_SYNC_FAILURE_NOTIFICATION_TYPE } from './exchange-rates-notification.service';
import { ExchangeRatesService } from './exchange-rates.service';

type Row = Record<string, unknown>;

const MONTHS_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** "septiembre de 2026" para un `YYYY-MM-01`. */
export const monthLabelEs = (month: string) => `${MONTHS_ES[Number(month.slice(5, 7)) - 1]} de ${month.slice(0, 4)}`;

/** Primer mes abierto de la compañía del contrato `c` (los meses cerrados con `get_cutoff_date` no se tocan nunca). */
const OPEN_FROM_SQL = `(date_trunc('month', public.get_cutoff_date(c.holding_id, c.company_id)) + interval '1 month')::date`;

/** Mes en curso del holding a la fecha `$2` (`holding_settings.timezone`, default America/Santiago): mismo criterio que el devengo. */
const CURRENT_MONTH_SQL = `(SELECT (DATE_TRUNC('month', $2::timestamptz AT TIME ZONE COALESCE(NULLIF(TRIM(hs.timezone), ''), 'America/Santiago')))::date
	FROM (SELECT $1::uuid AS holding_id) x LEFT JOIN holding_settings hs ON hs.holding_id = x.holding_id)`;

/**
 * Filas del devengo que el cierre tiene que recalcular (alias `r`, con `cur` = mes en curso del holding):
 * - meses terminados sin moneda de compañía (`pending_month_close` o `missing_fx_rate`): se completan si su promedio ya está cerrado;
 * - meses en curso o futuros convertidos con la regla anterior (`monthly_average*`): vuelven a quedar sin convertir;
 * - moneda de sistema con tasa proyectada (cualquier mes): se recalcula con la tasa registrada si ya existe, con la proyección vigente si
 *   el mes sigue siendo futuro, o queda sin tasa si el mes ya no es futuro y no hay tasa (regla de `holding_fixed_fx_rate`).
 */
export const NEEDS_FX_CLOSE_SQL = `(
	(r.period_month < cur.month AND r.fx_to_company_source IN ('pending_month_close', 'missing_fx_rate'))
	OR (r.period_month >= cur.month AND r.fx_to_company_source LIKE 'monthly_average%')
	OR r.fx_to_system_source LIKE '%\\_projected'
)`;

/**
 * Proceso del día 1 (decisión de Domi 04-10): cierra la moneda de compañía del mes que terminó.
 *
 * 1. **Promedio mensual**: para el mes terminado (y los terminados de los últimos 12 meses que sigan sin cerrar), revisa que cada par
 *    tenga sus tasas diarias completas (`isMonthComplete`) y recalcula su promedio (`ExchangeRatesService.calculateMonthlyAverages`),
 *    lo que lo deja **cerrado** (`calculated_at` posterior al fin del mes). Un par incompleto no se cierra (salvo `force`).
 * 2. **Devengo**, por holding (try/catch: uno que falla no detiene a los demás) y por contrato (una transacción `withApiWriter` con el
 *    contrato bloqueado): `revenue_schedule_apply_fx_for_contract(contrato, primer mes a recalcular)` para los contratos con filas que lo
 *    necesitan (`NEEDS_FX_CLOSE_SQL`), nunca en meses cerrados (`get_cutoff_date`). Completa la moneda de compañía del mes terminado en
 *    todas las columnas `_ccy` y recalcula la moneda de sistema de los meses que tenían tasa proyectada.
 * 3. **Aviso**: si quedan filas del mes terminado sin moneda de compañía, alerta por holding (tipo `fx_sync_failure`, clave
 *    `fx-month-close:YYYY-MM`); si ya no quedan, la cierra.
 *
 * Idempotente: repetirla deja el mismo resultado (solo vuelve a recalcular los contratos con algo pendiente o con tasa proyectada).
 */
@Injectable()
export class FxMonthCloseService {
	private readonly logger = new Logger(FxMonthCloseService.name);

	constructor(
		@InjectDataSource() private readonly dataSource: DataSource,
		private readonly exchangeRates: ExchangeRatesService,
		private readonly notifications: NotificationsService
	) {}

	/**
	 * Corre el cierre. `month` (`YYYY-MM` o `YYYY-MM-01`) = mes a cerrar (default: el que terminó según `asOf` en America/Santiago);
	 * `force` cierra los promedios de ese mes aunque sus tasas diarias estén incompletas (solo a mano, super admin; el backlog no).
	 */
	async run(options: { asOf?: Date; month?: string; force?: boolean } = {}): Promise<FxMonthCloseResult> {
		const asOf = options.asOf ?? new Date();
		const current = monthStartIn(asOf, FX_MONTH_CLOSE_TIMEZONE);
		const month = options.month ? `${options.month.slice(0, 7)}-01` : addMonths(current, -1);

		if (!/^\d{4}-\d{2}-01$/.test(month))
			throw new BadRequestException({ message: 'Mes inválido', errors: [{ field: 'month', message: 'Usa el formato AAAA-MM' }] });
		if (month >= current) {
			throw new BadRequestException({
				message: 'El mes todavía no termina',
				errors: [{ field: 'month', message: 'Elige un mes ya terminado' }],
			});
		}

		const closed_averages: string[] = [];
		const incomplete_averages: string[] = [];

		for (const candidate of await this.monthsToClose(current, month)) {
			const coverage = await this.coverage(candidate);
			const evaluated = coverage.map((pair) => isMonthComplete(candidate, pair));
			const toClose = evaluated.filter((pair) => pair.complete || (options.force && candidate === month));

			for (const pair of evaluated.filter((item) => !item.complete)) {
				incomplete_averages.push(`${candidate.slice(0, 7)} ${pair.from_currency}/${pair.to_currency}: ${pair.reason}`);
			}
			if (!toClose.length) continue;
			await this.exchangeRates.calculateMonthlyAverages(
				{ year: Number(candidate.slice(0, 4)), month: Number(candidate.slice(5, 7)) },
				toClose.map(({ from_currency, to_currency }) => ({ from_currency, to_currency }))
			);
			closed_averages.push(...toClose.map((pair) => `${candidate.slice(0, 7)} ${pair.from_currency}/${pair.to_currency}`));
		}
		if (incomplete_averages.length) {
			this.logger.warn(`${FX_MONTH_CLOSE_JOB}: promedios sin cerrar por tasas diarias incompletas: ${incomplete_averages.join('; ')}`);
		}

		const holdings: FxMonthCloseHoldingResult[] = [];

		for (const holdingId of await this.holdingIds()) {
			try {
				holdings.push(await this.closeHolding(holdingId, month, asOf));
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);

				this.logger.error(`${FX_MONTH_CLOSE_JOB}: falló el holding ${holdingId}: ${message}`);
				holdings.push({
					holding_id: holdingId,
					success: false,
					contracts: 0,
					failed_contracts: 0,
					pending_rows: 0,
					pending_pairs: [],
					error: message,
				});
			}
		}

		return { month, closed_averages, incomplete_averages, holdings };
	}

	/** Mes pedido + meses terminados de los últimos 12 con algún promedio sin cerrar (backlog). */
	async monthsToClose(current: string, month: string): Promise<string[]> {
		const rows = (await this.dataSource.query(
			`SELECT DISTINCT make_date(ma.year, ma.month, 1)::text AS month
			FROM exchange_rates_monthly_avg ma
			WHERE make_date(ma.year, ma.month, 1) < $1::date AND make_date(ma.year, ma.month, 1) >= $2::date
				AND (ma.calculated_at IS NULL OR ma.calculated_at < ((make_date(ma.year, ma.month, 1) + interval '1 month')::timestamp AT TIME ZONE $3))
			ORDER BY 1`,
			[current, addMonths(current, -FX_MONTH_CLOSE_LOOKBACK_MONTHS), FX_MONTH_CLOSE_TIMEZONE]
		)) as Row[];

		return [...new Set([...(rows ?? []).map((row) => String(row.month).slice(0, 10)), month])].sort();
	}

	/**
	 * Tasas diarias del mes por par (las mismas que entran al promedio: `MONTHLY_AVG_DAILY_RATES_SQL`, todas las fuentes diarias, una por
	 * día hábil), solo de pares cuyo promedio del mes no está cerrado.
	 */
	async coverage(month: string): Promise<PairDailyCoverage[]> {
		const rows = (await this.dataSource.query(
			`WITH daily AS (${MONTHLY_AVG_DAILY_RATES_SQL})
			SELECT d.from_currency, d.to_currency, COUNT(*)::int AS days, MAX(d.rate_date)::text AS last_date
			FROM daily d
			WHERE NOT EXISTS (
				SELECT 1 FROM exchange_rates_monthly_avg ma
				WHERE ma.from_currency = d.from_currency AND ma.to_currency = d.to_currency
					AND ma.year = EXTRACT(YEAR FROM $1::date)::int AND ma.month = EXTRACT(MONTH FROM $1::date)::int
					AND ma.data_points > 1 AND ma.calculated_at >= ($2::date::timestamp AT TIME ZONE $3)
			)
			GROUP BY d.from_currency, d.to_currency
			ORDER BY 1, 2`,
			[month, addMonths(month, 1), FX_MONTH_CLOSE_TIMEZONE]
		)) as Row[];

		return (rows ?? []).map((row) => ({
			from_currency: String(row.from_currency),
			to_currency: String(row.to_currency),
			days: Number(row.days ?? 0),
			last_date: row.last_date ? String(row.last_date).slice(0, 10) : null,
		}));
	}

	/** Recalcula los contratos del holding que lo necesitan, luego avisa (o cierra el aviso) según lo que quedó sin convertir del mes. */
	async closeHolding(holdingId: string, month: string, asOf: Date = new Date()): Promise<FxMonthCloseHoldingResult> {
		const contracts = (await this.dataSource.query(
			`WITH cur AS (SELECT ${CURRENT_MONTH_SQL} AS month)
			SELECT c.id::text AS id, MIN(r.period_month)::text AS from_month
			FROM contracts c
			JOIN revenue_schedule_monthly r ON r.contract_id = c.id AND COALESCE(r.is_total_row, false) = false
			CROSS JOIN cur
			WHERE c.holding_id = $1 AND c.deleted_at IS NULL
				AND r.period_month >= COALESCE(${OPEN_FROM_SQL}, r.period_month)
				AND ${NEEDS_FX_CLOSE_SQL}
			GROUP BY c.id
			ORDER BY c.id`,
			[holdingId, asOf.toISOString()]
		)) as Row[];
		let failed = 0;

		for (const contract of contracts ?? []) {
			try {
				await withApiWriter(this.dataSource, async (runner) => {
					await runner.query(`SELECT id FROM contracts WHERE id = $1 AND holding_id = $2 FOR UPDATE`, [contract.id, holdingId]);
					await runner.query(`SELECT public.revenue_schedule_apply_fx_for_contract($1::uuid, $2::date)`, [
						contract.id,
						String(contract.from_month).slice(0, 10),
					]);
				});
			} catch (error) {
				failed++;
				this.logger.error(
					`${FX_MONTH_CLOSE_JOB}: falló el contrato ${String(contract.id)} (holding ${holdingId}): ${error instanceof Error ? error.message : String(error)}`
				);
			}
		}

		const pending = (await this.dataSource.query(
			`SELECT UPPER(TRIM(c.contract_currency)) || ' → ' || UPPER(TRIM(co.currency)) AS pair, COUNT(*)::int AS rows
			FROM revenue_schedule_monthly r
			JOIN contracts c ON c.id = r.contract_id
			JOIN companies co ON co.id = c.company_id
			WHERE r.holding_id = $1 AND r.period_month = $2::date AND COALESCE(r.is_total_row, false) = false AND c.deleted_at IS NULL
				AND COALESCE(c.fx_company_policy, 'monthly_avg') = 'monthly_avg'
				AND r.recognized_period_ccy IS NULL AND r.recognized_cum_contract_ccy IS NOT NULL
				AND r.fx_to_company_source IN ('pending_month_close', 'missing_fx_rate')
				AND (COALESCE(r.recognized_period_contract_ccy, 0) <> 0 OR COALESCE(r.mrr_period_contracted_contract_ccy, 0) <> 0
					OR COALESCE(r.billed_period_contract_ccy, 0) <> 0 OR COALESCE(r.deferred_balance_eom_contract_ccy, 0) <> 0)
			GROUP BY 1
			ORDER BY 1`,
			[holdingId, month]
		)) as Row[];
		const pendingPairs = (pending ?? []).map((row) => String(row.pair));
		const pendingRows = (pending ?? []).reduce((sum, row) => sum + Number(row.rows ?? 0), 0);

		await this.notify(holdingId, month, pendingPairs, pendingRows);

		return {
			holding_id: holdingId,
			success: failed === 0,
			contracts: (contracts ?? []).length - failed,
			failed_contracts: failed,
			pending_rows: pendingRows,
			pending_pairs: pendingPairs,
		};
	}

	/** Alerta del mes por holding (o la cierra si ya no queda nada sin convertir). Nunca lanza. */
	private async notify(holdingId: string, month: string, pairs: string[], rows: number): Promise<void> {
		const key = fxMonthCloseKey(month);

		try {
			if (!pairs.length) {
				await this.notifications.resolveByDeduplicationKey(holdingId, key);

				return;
			}
			await this.notifications.createOrUpdate(holdingId, {
				source: 'banco-central',
				type: FX_SYNC_FAILURE_NOTIFICATION_TYPE,
				severity: 'warning',
				title: `Falta el tipo de cambio promedio de ${monthLabelEs(month)}`,
				message:
					`${rows} ${rows === 1 ? 'fila del devengo' : 'filas del devengo'} de ${monthLabelEs(month)} ${rows === 1 ? 'sigue' : 'siguen'} sin moneda de compañía (${pairs.join(', ')}): ` +
					'el promedio mensual de su tipo de cambio no está completo.',
				recommendation:
					'Revisa que estén cargadas las tasas diarias del mes en Administración › Monedas. Lo reintentamos cada día hasta el día 5.',
				action_type: 'review_fx_rates',
				action_payload: { href: '/administracion?tab=monedas' },
				metadata: { month: month.slice(0, 7), pairs, rows },
				deduplication_key: key,
			});
		} catch (error) {
			this.logger.warn(`${FX_MONTH_CLOSE_JOB}: aviso del holding ${holdingId}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async holdingIds(): Promise<string[]> {
		const rows = (await this.dataSource.query(
			`SELECT DISTINCT holding_id::text AS holding_id FROM contracts WHERE deleted_at IS NULL AND holding_id IS NOT NULL ORDER BY 1`
		)) as Row[];

		return (rows ?? []).map((row) => String(row.holding_id));
	}
}
