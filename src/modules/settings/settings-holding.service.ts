import { randomUUID } from 'crypto';

import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { accountsCompleteSql } from '@/core/utils/account-mappings';
import { isValidTimezone, loadHoldingPreferences, nextQuoteNumber } from '@/core/utils/holding-preferences';
import { validationException } from '@/core/utils/validation-errors';
import { todayFor } from '@/modules/contracts/business-date';
import { reminderLadder } from '@/modules/contracts/contract-renewals';

import { assertCurrency, displayDate, Row, toCount, toIsoDate, toNumber } from './settings-common';
import { COMPANY_LOGOS_BUCKET, LOGO_MAX_BYTES, LOGO_MIME_TYPES, SettingsStorageService } from './settings-storage.service';

import type {
	CreateFxRateDto,
	FxRatesQueryDto,
	FxSyncHistoryQueryDto,
	FxSyncMonthlyQueryDto,
	LogoUploadDto,
	UpdateFxRateDto,
	UpdateHoldingDto,
	UpdatePreferencesDto,
} from './dtos/holding.dto';

export const DEFAULT_PREFERENCES = { system_currency: 'USD', fx_system_policy: 'monthly_avg', auto_renewal_notice_days: 30 } as const;
const stripUndefined = <T extends object>(value: T): Partial<T> =>
	Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
/** Base de los pares que cargan los schedulers (Banco Central, SUNAT): USD→moneda. */
const FX_BASE = 'USD';

const holdingDto = (row: Row) => ({
	id: String(row.id),
	name: String(row.name ?? ''),
	website: (row.website as string | null) ?? null,
	phone: (row.phone as string | null) ?? null,
	email: (row.email as string | null) ?? null,
	logo_url: (row.logo_url as string | null) ?? null,
	users_count: toCount(row.users_count),
	last_activity_at: row.last_activity_at ?? null,
});

/** Datos del holding + resumen: miembros activos (sin super admins) y su último acceso (`users.last_access`). */
const HOLDING_SELECT = `SELECT h.id, h.name, h.website, h.phone, h.email, h.logo_url, m.users_count, m.last_activity_at
	FROM company_holdings h
	LEFT JOIN LATERAL (
		SELECT count(*) AS users_count, max(u.last_access) AS last_activity_at
		FROM user_holdings uh JOIN users u ON u.id = uh.user_id
		WHERE uh.holding_id = h.id AND uh.is_active = true AND COALESCE(u.is_super_admin, false) = false
	) m ON true`;

/** Motivo del bloqueo de moneda de consolidación y política de tipo de cambio (decisión de Domi 02-10 y 03-10). */
export const PREFERENCES_LOCKED_REASON =
	'El holding ya tiene contratos: la moneda de consolidación y la política de tipo de cambio no se pueden cambiar porque cambiarían todas las métricas históricas';

const fxRateDto = (row: Row) => ({
	id: String(row.id),
	from_currency: String(row.from_currency),
	to_currency: String(row.to_currency),
	rate: toNumber(row.rate),
	period_start: toIsoDate(row.period_start),
	period_end: toIsoDate(row.period_end),
	notes: (row.notes as string | null) ?? null,
	created_by_name: (row.created_by_name as string | null) ?? null,
	created_at: row.created_at,
	updated_at: row.updated_at,
});

/** Prepara la subida de un logo al bucket público `company-logos` (`<folder>/<uuid>.<ext>`). */
export async function prepareLogoUpload(storage: SettingsStorageService, folder: string, input: LogoUploadDto) {
	const extension = LOGO_MIME_TYPES[input.mime_type];

	if (!extension) throw validationException([{ field: 'mime_type', message: 'El logo debe ser PNG, JPG o WEBP' }]);
	if (input.size > LOGO_MAX_BYTES) throw validationException([{ field: 'size', message: 'El logo no puede superar 2 MB' }]);
	const path = `${folder}/${randomUUID()}.${extension}`;
	const upload = await storage.createUploadUrl(COMPANY_LOGOS_BUCKET, path);

	return { path, upload_url: upload.signedUrl, token: upload.token, public_url: storage.publicUrl(path) };
}

/** `logo_url` aceptado: `null` o una URL pública del bucket de logos dentro de la carpeta del dueño. */
export function assertLogoUrl(storage: SettingsStorageService, folder: string, value: string | null | undefined, current: unknown): void {
	if (value === undefined || value === null || value === current) return;
	if (!value.startsWith(storage.publicPrefix(folder))) {
		throw validationException([{ field: 'logo_url', message: 'El logo debe subirse con "Subir logo"' }]);
	}
}

/**
 * Holding 360 de Configuración: datos del holding (`company_holdings`), preferencias (`holding_settings`), tasas fijas por período
 * (`holding_fx_period_rates`), estado de la sincronización de tipos de cambio (`exchange_rates`, global) y el árbol holding → compañías.
 * Las validaciones de tasas viven aquí; el trigger `validate_holding_fx_period_rates` queda como invariante.
 */
@Injectable()
export class SettingsHoldingService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly storage: SettingsStorageService
	) {}

	async getHolding(holdingId: string) {
		const [row] = (await this.dataSource.query(`${HOLDING_SELECT} WHERE h.id = $1`, [holdingId])) as Row[];

		if (!row) throw new NotFoundException('Holding no encontrado');

		return holdingDto(row);
	}

	/** El nombre del holding no se edita desde aquí (decisión de Domi 03-10): solo sitio, correo, teléfono y logo. */
	async updateHolding(holdingId: string, dto: UpdateHoldingDto) {
		const current = await this.getHolding(holdingId);

		assertLogoUrl(this.storage, `holdings/${holdingId}`, dto.logo_url, current.logo_url);
		const fields = (['website', 'phone', 'email', 'logo_url'] as const).filter((field) => dto[field] !== undefined);

		if (!fields.length) return current;
		const sets = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');

		await this.dataSource.query(`UPDATE company_holdings SET ${sets} WHERE id = $1`, [holdingId, ...fields.map((field) => dto[field] ?? null)]);

		return this.getHolding(holdingId);
	}

	prepareLogoUpload(holdingId: string, input: LogoUploadDto) {
		return prepareLogoUpload(this.storage, `holdings/${holdingId}`, input);
	}

	/** `true` si el holding tiene contratos (no borrados): bloquea moneda de consolidación y política de tipo de cambio. */
	private async hasContracts(holdingId: string): Promise<boolean> {
		const rows = (await this.dataSource.query(`SELECT 1 FROM contracts WHERE holding_id = $1 AND deleted_at IS NULL LIMIT 1`, [
			holdingId,
		])) as Row[];

		return rows.length > 0;
	}

	private async readPreferences(holdingId: string) {
		const [[row], runtime] = await Promise.all([
			this.dataSource.query(`SELECT system_currency, fx_system_policy FROM holding_settings WHERE holding_id = $1`, [holdingId]) as Promise<
				Row[]
			>,
			loadHoldingPreferences(this.dataSource, holdingId),
		]);

		return {
			system_currency: String(row?.system_currency ?? DEFAULT_PREFERENCES.system_currency),
			fx_system_policy: String(row?.fx_system_policy ?? DEFAULT_PREFERENCES.fx_system_policy),
			...runtime,
		};
	}

	/**
	 * Preferencias + `locked` (moneda de consolidación y política FX de solo lectura) y su motivo para el front. Ronda 4: zona horaria,
	 * escalera de recordatorios (+ la escalera efectiva del job) y numeración de cotizaciones con la vista previa del próximo número.
	 */
	async getPreferences(holdingId: string) {
		const [preferences, locked] = await Promise.all([this.readPreferences(holdingId), this.hasContracts(holdingId)]);
		const { timezone, quote_numbering: numbering, ...rest } = preferences;
		const year = Number(todayFor(timezone).slice(0, 4));

		return {
			system_currency: rest.system_currency,
			fx_system_policy: rest.fx_system_policy,
			auto_renewal_notice_days: rest.auto_renewal_notice_days,
			locked,
			locked_reason: locked ? PREFERENCES_LOCKED_REASON : null,
			timezone,
			renewal_reminder_days: rest.renewal_reminder_days,
			renewal_overdue_every_days: rest.renewal_overdue_every_days,
			renewal_reminder_ladder: reminderLadder(rest.auto_renewal_notice_days, rest.renewal_reminder_days),
			quote_numbering: { ...numbering, next_number_preview: await nextQuoteNumber(this.dataSource, holdingId, numbering, year) },
		};
	}

	async updatePreferences(holdingId: string, dto: UpdatePreferencesDto) {
		const current = await this.readPreferences(holdingId);

		if (dto.timezone !== undefined && !isValidTimezone(dto.timezone)) {
			throw validationException([{ field: 'timezone', message: `Zona horaria no reconocida: ${dto.timezone}` }]);
		}
		const next = {
			system_currency: dto.system_currency
				? await assertCurrency(this.dataSource, dto.system_currency, 'system_currency')
				: current.system_currency,
			fx_system_policy: dto.fx_system_policy ?? current.fx_system_policy,
			auto_renewal_notice_days: dto.auto_renewal_notice_days ?? current.auto_renewal_notice_days,
			timezone: dto.timezone ?? current.timezone,
			// Se guarda de mayor a menor (la escalera la lee el job y la UI así).
			renewal_reminder_days: dto.renewal_reminder_days ? [...dto.renewal_reminder_days].sort((a, b) => b - a) : current.renewal_reminder_days,
			renewal_overdue_every_days: dto.renewal_overdue_every_days ?? current.renewal_overdue_every_days,
			quote_numbering: { ...current.quote_numbering, ...stripUndefined(dto.quote_numbering ?? {}) },
		};
		const changesCurrency = next.system_currency !== current.system_currency;
		const changesPolicy = next.fx_system_policy !== current.fx_system_policy;

		// Decisión de Domi (02-10 y 03-10): con contratos, ni la moneda de consolidación ni la política FX cambian (cambiarían todas las
		// métricas históricas). Enviar el mismo valor no cuenta como cambio. Las preferencias de la ronda 4 rigen hacia adelante: sin bloqueo.
		if ((changesCurrency || changesPolicy) && (await this.hasContracts(holdingId))) {
			throw new ConflictException(
				changesCurrency
					? 'No se puede cambiar la moneda de consolidación: el holding ya tiene contratos y cambiaría todas las métricas históricas'
					: 'No se puede cambiar la política de tipo de cambio: el holding ya tiene contratos y cambiaría todas las métricas históricas'
			);
		}

		await this.dataSource.query(
			`INSERT INTO holding_settings (holding_id, system_currency, fx_system_policy, auto_renewal_notice_days, timezone,
				renewal_reminder_days, renewal_overdue_every_days, quote_numbering_mode, quote_number_prefix, quote_number_include_year,
				quote_number_width)
			VALUES ($1, $2, $3, $4, $5, $6::smallint[], $7, $8, $9, $10, $11)
			ON CONFLICT (holding_id) DO UPDATE SET system_currency = EXCLUDED.system_currency, fx_system_policy = EXCLUDED.fx_system_policy,
				auto_renewal_notice_days = EXCLUDED.auto_renewal_notice_days, timezone = EXCLUDED.timezone,
				renewal_reminder_days = EXCLUDED.renewal_reminder_days,
				renewal_overdue_every_days = EXCLUDED.renewal_overdue_every_days, quote_numbering_mode = EXCLUDED.quote_numbering_mode,
				quote_number_prefix = EXCLUDED.quote_number_prefix, quote_number_include_year = EXCLUDED.quote_number_include_year,
				quote_number_width = EXCLUDED.quote_number_width, updated_at = now()`,
			[
				holdingId,
				next.system_currency,
				next.fx_system_policy,
				next.auto_renewal_notice_days,
				next.timezone,
				next.renewal_reminder_days,
				next.renewal_overdue_every_days,
				next.quote_numbering.mode,
				next.quote_numbering.prefix,
				next.quote_numbering.include_year,
				next.quote_numbering.width,
			]
		);

		return this.getPreferences(holdingId);
	}

	// ── Tasas fijas por período ─────────────────────────────────────────────────────────────────────────────────────────────────

	async listFxRates(holdingId: string, query: FxRatesQueryDto = {}) {
		const params: unknown[] = [holdingId];
		const filters: string[] = [];

		if (query.from_currency) filters.push(`r.from_currency = $${params.push(query.from_currency.toUpperCase())}`);
		if (query.to_currency) filters.push(`r.to_currency = $${params.push(query.to_currency.toUpperCase())}`);
		const rows = (await this.dataSource.query(
			`SELECT r.*, u.name AS created_by_name FROM holding_fx_period_rates r LEFT JOIN users u ON u.id = r.created_by
			WHERE r.holding_id = $1 ${filters.map((filter) => `AND ${filter}`).join(' ')}
			ORDER BY r.period_start DESC, r.from_currency, r.to_currency`,
			params
		)) as Row[];

		return rows.map(fxRateDto);
	}

	private async findFxRate(holdingId: string, id: string): Promise<Row> {
		const [row] = (await this.dataSource.query(
			`SELECT r.*, u.name AS created_by_name FROM holding_fx_period_rates r LEFT JOIN users u ON u.id = r.created_by
			WHERE r.id = $1 AND r.holding_id = $2`,
			[id, holdingId]
		)) as Row[];

		if (!row) throw new NotFoundException('Tasa no encontrada');

		return row;
	}

	/** Reglas de una tasa (las mismas que el trigger, con mensajes claros) y que no se cruce con otra del mismo par. */
	private async validateFxRate(
		holdingId: string,
		rate: { from_currency: string; to_currency: string; rate: number; period_start: string; period_end: string },
		excludeId: string | null
	) {
		const from = await assertCurrency(this.dataSource, rate.from_currency, 'from_currency');
		const to = await assertCurrency(this.dataSource, rate.to_currency, 'to_currency');

		if (from === to) throw validationException([{ field: 'to_currency', message: 'Las monedas de origen y destino deben ser distintas' }]);
		if (!(rate.rate > 0)) throw validationException([{ field: 'rate', message: 'La tasa debe ser mayor que cero' }]);
		if (rate.period_end < rate.period_start) {
			throw validationException([{ field: 'period_end', message: 'La fecha de fin debe ser igual o posterior a la de inicio' }]);
		}
		const [overlap] = (await this.dataSource.query(
			`SELECT period_start, period_end FROM holding_fx_period_rates
			WHERE holding_id = $1 AND from_currency = $2 AND to_currency = $3 AND id IS DISTINCT FROM $4::uuid
				AND period_start <= $6::date AND period_end >= $5::date
			LIMIT 1`,
			[holdingId, from, to, excludeId, rate.period_start, rate.period_end]
		)) as Row[];

		if (overlap) {
			throw new ConflictException(
				`Ya hay una tasa ${from}→${to} que se cruza con ese período (${displayDate(toIsoDate(overlap.period_start))} a ${displayDate(toIsoDate(overlap.period_end))})`
			);
		}

		return { ...rate, from_currency: from, to_currency: to };
	}

	async createFxRate(holdingId: string, dto: CreateFxRateDto, userId: string | null) {
		const rate = await this.validateFxRate(holdingId, dto, null);
		const [row] = (await this.dataSource.query(
			`INSERT INTO holding_fx_period_rates (holding_id, from_currency, to_currency, rate, period_start, period_end, notes, created_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
			[holdingId, rate.from_currency, rate.to_currency, rate.rate, rate.period_start, rate.period_end, dto.notes ?? null, userId]
		)) as Row[];

		return fxRateDto(await this.findFxRate(holdingId, String(row.id)));
	}

	async updateFxRate(holdingId: string, id: string, dto: UpdateFxRateDto) {
		const current = await this.findFxRate(holdingId, id);
		const rate = await this.validateFxRate(
			holdingId,
			{
				from_currency: dto.from_currency ?? String(current.from_currency),
				to_currency: dto.to_currency ?? String(current.to_currency),
				rate: dto.rate ?? Number(current.rate),
				period_start: dto.period_start ?? String(toIsoDate(current.period_start)),
				period_end: dto.period_end ?? String(toIsoDate(current.period_end)),
			},
			id
		);

		await this.dataSource.query(
			`UPDATE holding_fx_period_rates SET from_currency = $3, to_currency = $4, rate = $5, period_start = $6, period_end = $7,
				notes = $8, updated_at = now()
			WHERE id = $1 AND holding_id = $2`,
			[
				id,
				holdingId,
				rate.from_currency,
				rate.to_currency,
				rate.rate,
				rate.period_start,
				rate.period_end,
				dto.notes === undefined ? (current.notes ?? null) : dto.notes,
			]
		);

		return fxRateDto(await this.findFxRate(holdingId, id));
	}

	async deleteFxRate(holdingId: string, id: string): Promise<void> {
		await this.findFxRate(holdingId, id);
		await this.dataSource.query(`DELETE FROM holding_fx_period_rates WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}

	// ── Sincronización automática (solo lectura) ────────────────────────────────────────────────────────────────────────────────

	/** Monedas en uso: consolidación + compañías + ítems de contrato del holding. */
	async currenciesInUse(holdingId: string): Promise<string[]> {
		const rows = (await this.dataSource.query(
			`SELECT DISTINCT upper(code) AS code FROM (
				SELECT system_currency AS code FROM holding_settings WHERE holding_id = $1
				UNION SELECT currency FROM companies WHERE holding_id = $1
				UNION SELECT currency FROM contract_items WHERE holding_id = $1
			) s WHERE code IS NOT NULL AND code <> ''
			ORDER BY 1`,
			[holdingId]
		)) as Row[];

		return rows.map((row) => String(row.code));
	}

	async fxSyncStatus(holdingId: string) {
		const currencies = (await this.currenciesInUse(holdingId)).filter((code) => code !== FX_BASE);

		if (!currencies.length) return { base_currency: FX_BASE, currencies: [] };
		const rows = (await this.dataSource.query(
			`SELECT DISTINCT ON (to_currency) to_currency, rate_date, rate, source_type, api_source
			FROM exchange_rates
			WHERE from_currency = $1 AND to_currency = ANY($2::text[]) AND source_type <> 'system'
			ORDER BY to_currency, rate_date DESC, created_at DESC`,
			[FX_BASE, currencies]
		)) as Row[];
		const byCurrency = new Map(rows.map((row) => [String(row.to_currency), row]));
		const today = new Date(`${toIsoDate(new Date())}T00:00:00Z`).getTime();

		return {
			base_currency: FX_BASE,
			currencies: currencies.map((currency) => {
				const row = byCurrency.get(currency);
				const last = row ? toIsoDate(row.rate_date) : null;

				return {
					currency,
					pair: `${FX_BASE}/${currency}`,
					last_rate_date: last,
					rate: row ? toNumber(row.rate) : null,
					source_type: row ? String(row.source_type) : null,
					source_label: row ? ((row.api_source as string | null) ?? String(row.source_type)) : null,
					days_old: last ? Math.max(0, Math.round((today - new Date(`${last}T00:00:00Z`).getTime()) / 86_400_000)) : null,
				};
			}),
		};
	}

	// ── Detalle de la sincronización (ronda 3, contrato §8.3) ───────────────────────────────────────────────────────────────────

	/** Moneda pedida: en uso en el holding y distinta de la de consolidación. Devuelve ambas. */
	private async fxPair(holdingId: string, raw: string) {
		const currency = await assertCurrency(this.dataSource, raw);
		const [inUse, preferences] = await Promise.all([this.currenciesInUse(holdingId), this.readPreferences(holdingId)]);
		const consolidation = String(preferences.system_currency).toUpperCase();

		if (currency === consolidation) throw new BadRequestException(`${currency} es la moneda de consolidación: no tiene tipo de cambio`);
		if (!inUse.includes(currency)) throw new BadRequestException(`La moneda ${currency} no está en uso en el holding`);

		return { currency, consolidation };
	}

	/**
	 * Tasa diaria `currency → consolidation` (unidades de consolidación por 1 de `currency`) entre dos fechas: fila directa, inversa (1/tasa)
	 * o cruce por USD. Sin filas `system`; por día y par gana la carga más reciente.
	 */
	private async dailyFx(currency: string, consolidation: string, from: string, to: string) {
		const pairs: [string, string][] = [
			[currency, consolidation],
			[consolidation, currency],
			[FX_BASE, currency],
			[currency, FX_BASE],
			[FX_BASE, consolidation],
			[consolidation, FX_BASE],
		];
		const rows = (await this.dataSource.query(
			`SELECT DISTINCT ON (rate_date, from_currency, to_currency) rate_date, from_currency, to_currency, rate, source_type, api_source
			FROM exchange_rates
			WHERE rate_date BETWEEN $1::date AND $2::date AND source_type <> 'system' AND rate > 0
				AND (from_currency, to_currency) IN (SELECT * FROM unnest($3::text[], $4::text[]))
			ORDER BY rate_date, from_currency, to_currency, created_at DESC`,
			[from, to, pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1])]
		)) as Row[];
		const byDate = new Map<string, Map<string, Row>>();

		for (const row of rows) {
			const date = toIsoDate(row.rate_date) as string;
			const entry = byDate.get(date) ?? new Map<string, Row>();

			entry.set(`${String(row.from_currency)}>${String(row.to_currency)}`, row);
			byDate.set(date, entry);
		}
		const label = (row: Row) => (row.api_source as string | null) ?? String(row.source_type);
		/** Tasa `a → b` del día (directa o inversa) con su fila de origen. */
		const leg = (day: Map<string, Row>, a: string, b: string): { rate: number; row: Row | null } | null => {
			if (a === b) return { rate: 1, row: null };
			const direct = day.get(`${a}>${b}`);

			if (direct) return { rate: Number(direct.rate), row: direct };
			const inverse = day.get(`${b}>${a}`);

			return inverse ? { rate: 1 / Number(inverse.rate), row: inverse } : null;
		};
		const round = (value: number) => Number(value.toPrecision(10));
		const points: { date: string; rate: number; source_type: string; source_label: string; method: 'direct' | 'inverse' | 'cross_usd' }[] = [];

		for (const [date, day] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			const direct = day.get(`${currency}>${consolidation}`);
			const inverse = day.get(`${consolidation}>${currency}`);

			if (direct)
				points.push({
					date,
					rate: round(Number(direct.rate)),
					source_type: String(direct.source_type),
					source_label: label(direct),
					method: 'direct',
				});
			else if (inverse) {
				points.push({
					date,
					rate: round(1 / Number(inverse.rate)),
					source_type: String(inverse.source_type),
					source_label: label(inverse),
					method: 'inverse',
				});
			} else {
				const toUsd = leg(day, currency, FX_BASE);
				const fromUsd = leg(day, FX_BASE, consolidation);

				if (!toUsd || !fromUsd) continue;
				const source = toUsd.row ?? fromUsd.row;

				if (!source) continue;
				points.push({
					date,
					rate: round(toUsd.rate * fromUsd.rate),
					source_type: String(source.source_type),
					source_label: label(source),
					method: 'cross_usd',
				});
			}
		}

		return points;
	}

	async fxSyncHistory(holdingId: string, query: FxSyncHistoryQueryDto) {
		const { currency, consolidation } = await this.fxPair(holdingId, query.currency);
		const today = toIsoDate(new Date()) as string;
		const to = query.to ?? today;
		const from = query.from ?? toIsoDate(new Date(new Date(`${to}T00:00:00Z`).getTime() - 89 * 86_400_000).toISOString().slice(0, 10)) ?? to;

		if (from > to) throw new BadRequestException('La fecha de inicio debe ser anterior o igual a la de fin');
		if ((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000 > 731) {
			throw new BadRequestException('El rango no puede superar 2 años');
		}

		return { currency, to_currency: consolidation, from, to, points: await this.dailyFx(currency, consolidation, from, to) };
	}

	async fxSyncMonthly(holdingId: string, query: FxSyncMonthlyQueryDto) {
		const { currency, consolidation } = await this.fxPair(holdingId, query.currency);
		const year = query.year ?? Number((toIsoDate(new Date()) as string).slice(0, 4));
		const rows = (await this.dataSource.query(
			`SELECT from_currency, to_currency, month, avg_rate, min_rate, max_rate, data_points, calculated_at
			FROM exchange_rates_monthly_avg
			WHERE year = $1 AND ((from_currency = $2 AND to_currency = $3) OR (from_currency = $3 AND to_currency = $2)) AND avg_rate > 0`,
			[year, currency, consolidation]
		)) as Row[];
		const direct = new Map(rows.filter((row) => row.from_currency === currency).map((row) => [Number(row.month), row]));
		const inverse = new Map(rows.filter((row) => row.from_currency === consolidation).map((row) => [Number(row.month), row]));
		const round = (value: number | null) => (value === null || !Number.isFinite(value) ? null : Number(value.toPrecision(10)));
		const invert = (value: unknown) => (toNumber(value) ? 1 / (toNumber(value) as number) : null);
		const missing = Array.from({ length: 12 }, (_, index) => index + 1).filter((month) => !direct.has(month) && !inverse.has(month));
		const daily = missing.length ? await this.dailyFx(currency, consolidation, `${year}-01-01`, `${year}-12-31`) : [];

		return {
			currency,
			to_currency: consolidation,
			year,
			months: Array.from({ length: 12 }, (_, index) => {
				const month = index + 1;
				const own = direct.get(month);
				const other = inverse.get(month);

				if (own) {
					return {
						month,
						avg_rate: round(toNumber(own.avg_rate)),
						min_rate: round(toNumber(own.min_rate)),
						max_rate: round(toNumber(own.max_rate)),
						data_points: toNumber(own.data_points),
						source: 'monthly_avg' as const,
						calculated_at: own.calculated_at ?? null,
					};
				}
				if (other) {
					return {
						month,
						avg_rate: round(invert(other.avg_rate)),
						min_rate: round(invert(other.max_rate)),
						max_rate: round(invert(other.min_rate)),
						data_points: toNumber(other.data_points),
						source: 'monthly_avg_inverse' as const,
						calculated_at: other.calculated_at ?? null,
					};
				}
				const prefix = `${year}-${String(month).padStart(2, '0')}`;
				const rates = daily.filter((point) => point.date.startsWith(prefix)).map((point) => point.rate);

				return rates.length
					? {
							month,
							avg_rate: round(rates.reduce((sum, rate) => sum + rate, 0) / rates.length),
							min_rate: round(Math.min(...rates)),
							max_rate: round(Math.max(...rates)),
							data_points: rates.length,
							source: 'daily' as const,
							calculated_at: null,
						}
					: { month, avg_rate: null, min_rate: null, max_rate: null, data_points: 0, source: null, calculated_at: null };
			}),
		};
	}

	// ── Árbol ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

	async tree(holdingId: string) {
		const holding = await this.getHolding(holdingId);
		const preferences = await this.readPreferences(holdingId);
		const companies = (await this.dataSource.query(
			`SELECT c.id, c.legal_name, c.country_code, c.country, c.currency, c.logo_url, c.odoo_integration_id,
				pc.cutoff_date,
				${accountsCompleteSql('m')} AS accounts_complete,
				EXISTS (SELECT 1 FROM sii_configurations s WHERE s.company_id = c.id AND s.holding_id = c.holding_id AND s.is_enabled = true) AS sii_configured
			FROM companies c
			LEFT JOIN accounting_period_cutoff pc ON pc.company_id = c.id AND pc.holding_id = c.holding_id
			LEFT JOIN company_account_mappings m ON m.company_id = c.id
			WHERE c.holding_id = $1
			ORDER BY c.legal_name NULLS LAST, c.created_at`,
			[holdingId]
		)) as Row[];

		return {
			holding: {
				id: holding.id,
				name: holding.name,
				logo_url: holding.logo_url,
				system_currency: preferences.system_currency,
				fx_system_policy: preferences.fx_system_policy,
			},
			companies: companies.map((row) => ({
				id: String(row.id),
				legal_name: (row.legal_name as string | null) ?? null,
				country_code: (row.country_code as string | null)?.trim() ?? null,
				country: (row.country as string | null) ?? null,
				currency: (row.currency as string | null) ?? null,
				logo_url: (row.logo_url as string | null) ?? null,
				closed_until: toIsoDate(row.cutoff_date),
				accounts_complete: row.accounts_complete === true,
				sii_configured: row.sii_configured === true,
				erp_linked: row.odoo_integration_id !== null && row.odoo_integration_id !== undefined,
			})),
		};
	}
}
