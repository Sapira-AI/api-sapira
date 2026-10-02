import { randomUUID } from 'crypto';

import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';

import { assertCurrency, displayDate, Row, toIsoDate, toNumber } from './settings-common';
import { COMPANY_LOGOS_BUCKET, LOGO_MAX_BYTES, LOGO_MIME_TYPES, SettingsStorageService } from './settings-storage.service';

import type { CreateFxRateDto, FxRatesQueryDto, LogoUploadDto, UpdateFxRateDto, UpdateHoldingDto, UpdatePreferencesDto } from './dtos/holding.dto';

export const DEFAULT_PREFERENCES = { system_currency: 'USD', fx_system_policy: 'monthly_avg', auto_renewal_notice_days: 30 } as const;
/** Base de los pares que cargan los schedulers (Banco Central, SUNAT): USD→moneda. */
const FX_BASE = 'USD';

const holdingDto = (row: Row) => ({
	id: String(row.id),
	name: String(row.name ?? ''),
	website: (row.website as string | null) ?? null,
	phone: (row.phone as string | null) ?? null,
	email: (row.email as string | null) ?? null,
	logo_url: (row.logo_url as string | null) ?? null,
});

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

	if (!extension) throw validationException([{ field: 'mime_type', message: 'El logo debe ser PNG, JPG, WEBP o SVG' }]);
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
		const [row] = (await this.dataSource.query(`SELECT id, name, website, phone, email, logo_url FROM company_holdings WHERE id = $1`, [
			holdingId,
		])) as Row[];

		if (!row) throw new NotFoundException('Holding no encontrado');

		return holdingDto(row);
	}

	async updateHolding(holdingId: string, dto: UpdateHoldingDto) {
		const current = await this.getHolding(holdingId);

		assertLogoUrl(this.storage, `holdings/${holdingId}`, dto.logo_url, current.logo_url);
		const fields = (['name', 'website', 'phone', 'email', 'logo_url'] as const).filter((field) => dto[field] !== undefined);

		if (!fields.length) return current;
		const sets = fields.map((field, index) => `${field} = $${index + 2}`).join(', ');
		const [row] = (await this.dataSource.query(
			`UPDATE company_holdings SET ${sets} WHERE id = $1 RETURNING id, name, website, phone, email, logo_url`,
			[holdingId, ...fields.map((field) => dto[field] ?? null)]
		)) as Row[];

		return holdingDto(row);
	}

	prepareLogoUpload(holdingId: string, input: LogoUploadDto) {
		return prepareLogoUpload(this.storage, `holdings/${holdingId}`, input);
	}

	async getPreferences(holdingId: string) {
		const [row] = (await this.dataSource.query(
			`SELECT system_currency, fx_system_policy, auto_renewal_notice_days FROM holding_settings WHERE holding_id = $1`,
			[holdingId]
		)) as Row[];

		return {
			system_currency: String(row?.system_currency ?? DEFAULT_PREFERENCES.system_currency),
			fx_system_policy: String(row?.fx_system_policy ?? DEFAULT_PREFERENCES.fx_system_policy),
			auto_renewal_notice_days: Number(row?.auto_renewal_notice_days ?? DEFAULT_PREFERENCES.auto_renewal_notice_days),
		};
	}

	async updatePreferences(holdingId: string, dto: UpdatePreferencesDto) {
		const current = await this.getPreferences(holdingId);
		const next = {
			system_currency: dto.system_currency
				? await assertCurrency(this.dataSource, dto.system_currency, 'system_currency')
				: current.system_currency,
			fx_system_policy: dto.fx_system_policy ?? current.fx_system_policy,
			auto_renewal_notice_days: dto.auto_renewal_notice_days ?? current.auto_renewal_notice_days,
		};

		if (next.system_currency !== current.system_currency) {
			// Decisión de Domi (02-10): la moneda de consolidación no cambia con contratos (cambiaría todas las métricas históricas).
			const [row] = (await this.dataSource.query(`SELECT count(*) AS n FROM contracts WHERE holding_id = $1 AND deleted_at IS NULL`, [
				holdingId,
			])) as Row[];

			if (Number(row?.n ?? 0) > 0) {
				throw new ConflictException(
					'No se puede cambiar la moneda de consolidación: el holding ya tiene contratos y cambiaría todas las métricas históricas'
				);
			}
		}

		await this.dataSource.query(
			`INSERT INTO holding_settings (holding_id, system_currency, fx_system_policy, auto_renewal_notice_days)
			VALUES ($1, $2, $3, $4)
			ON CONFLICT (holding_id) DO UPDATE SET system_currency = EXCLUDED.system_currency, fx_system_policy = EXCLUDED.fx_system_policy,
				auto_renewal_notice_days = EXCLUDED.auto_renewal_notice_days, updated_at = now()`,
			[holdingId, next.system_currency, next.fx_system_policy, next.auto_renewal_notice_days]
		);

		return next;
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

	// ── Árbol ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

	async tree(holdingId: string) {
		const holding = await this.getHolding(holdingId);
		const preferences = await this.getPreferences(holdingId);
		const companies = (await this.dataSource.query(
			`SELECT c.id, c.legal_name, c.country_code, c.country, c.currency, c.logo_url, c.odoo_integration_id,
				pc.cutoff_date,
				(m.id IS NOT NULL
					AND NULLIF(btrim(m.receivable_account_code), '') IS NOT NULL AND NULLIF(btrim(m.receivable_account_name), '') IS NOT NULL
					AND NULLIF(btrim(m.deferred_account_code), '') IS NOT NULL AND NULLIF(btrim(m.deferred_account_name), '') IS NOT NULL
					AND NULLIF(btrim(m.unbilled_account_code), '') IS NOT NULL AND NULLIF(btrim(m.unbilled_account_name), '') IS NOT NULL
					AND NULLIF(btrim(m.revenue_account_code), '') IS NOT NULL AND NULLIF(btrim(m.revenue_account_name), '') IS NOT NULL
					AND NULLIF(btrim(m.fx_difference_account_code), '') IS NOT NULL AND NULLIF(btrim(m.fx_difference_account_name), '') IS NOT NULL
				) AS accounts_complete,
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
