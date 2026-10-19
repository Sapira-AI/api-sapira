import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { EncryptionService } from '@/common/services/encryption.service';
import { validationException } from '@/core/utils/validation-errors';

import { KameApiError, KameClientService, type KameCredential } from './kame-client.service';
import {
	allowedKameRuts,
	isKameRutAllowed,
	KAME_ENVIRONMENT_LABELS,
	KAME_ENVIRONMENTS,
	type KameEnvironment,
	kameJobEnabled,
	kameRutGuard,
	monthStartOf,
	normalizeKameRut,
	secretLast4,
} from './kame.types';

/** Fila de `kame_connections` (con el secret cifrado: nunca sale de la API). */
export interface KameConnectionRow {
	id: string;
	holding_id: string;
	company_id: string;
	environment: KameEnvironment;
	client_id: string;
	client_secret_encrypted: string;
	user_email: string;
	kame_company_rut: string;
	business_unit: string | null;
	branch: string | null;
	tested_at: Date | string | null;
	test_error: string | null;
	updated_at: Date | string | null;
}

export interface KameSettingsRow {
	company_id: string;
	active_environment: KameEnvironment;
	enabled: boolean;
	send_invoices: boolean;
	send_journal: boolean;
	dry_run: boolean;
	invoices_from: string | null;
	journal_from: string | null;
	updated_at: Date | string | null;
}

export interface KameConnectionInput {
	client_id: string;
	client_secret?: string;
	user_email: string;
	kame_company_rut: string;
	business_unit?: string | null;
	branch?: string | null;
}

export interface KameSettingsInput {
	enabled?: boolean;
	send_invoices?: boolean;
	send_journal?: boolean;
	dry_run?: boolean;
	invoices_from?: string | null;
	journal_from?: string | null;
}

export interface KameEnvironmentInput {
	environment: KameEnvironment;
	/** Al pasar a producción: desde qué fecha de emisión se registran las facturas en la empresa real. */
	invoices_from?: string | null;
	/** Al pasar a producción: primer mes (YYYY-MM) cuyos asientos van a la empresa real. */
	journal_from?: string | null;
}

export const DEFAULT_SETTINGS: Omit<KameSettingsRow, 'company_id' | 'updated_at'> = {
	active_environment: 'pruebas',
	enabled: false,
	send_invoices: false,
	send_journal: false,
	dry_run: true,
	invoices_from: null,
	journal_from: null,
};

const isoDate = (value: Date | string | null | undefined) =>
	value == null ? null : typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

/** Nombres de las unidades de negocio que devuelve Kame (la forma de la respuesta no está documentada: se lee con tolerancia). */
export function businessUnitNames(data: unknown): string[] {
	const list = Array.isArray(data) ? data : Array.isArray((data as { data?: unknown })?.data) ? (data as { data: unknown[] }).data : [];
	const names = list.map((item) => {
		if (typeof item === 'string') return item;
		const record = (item ?? {}) as Record<string, unknown>;
		const key = Object.keys(record).find((candidate) => /nombre|unidad|descrip/i.test(candidate) && typeof record[candidate] === 'string');

		return key ? String(record[key]) : null;
	});

	return [...new Set(names.filter((name): name is string => Boolean(name?.trim())).map((name) => name.trim()))];
}

/**
 * Conexiones de Kame por compañía y ambiente (pruebas / producción) y los interruptores de cada compañía (`kame_company_settings`).
 * Todo acotado al holding: una compañía de otro holding responde 404. El secret se cifra al guardar y solo se descifra para pedir el token.
 */
@Injectable()
export class KameConnectionsService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly encryption: EncryptionService,
		private readonly client: KameClientService
	) {}

	// ── Lectura ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

	/** Compañías chilenas del holding con su uso de Kame: conexiones (sin secretos), interruptores y conteo de envíos. */
	async overview(holdingId: string) {
		const [companies, connections, settings, counts, auto] = await Promise.all([
			this.dataSource.query(
				`SELECT co.id::text AS id, co.legal_name, co.tax_id, (co.odoo_integration_id IS NOT NULL) AS has_odoo,
					EXISTS (SELECT 1 FROM sii_configurations s WHERE s.company_id = co.id AND s.holding_id = co.holding_id AND s.is_enabled = true) AS dte_enabled
				FROM companies co
				WHERE co.holding_id = $1 AND upper(COALESCE(co.country_code, co.country, '')) IN ('CL', 'CHILE')
				ORDER BY co.legal_name`,
				[holdingId]
			),
			this.dataSource.query(`SELECT * FROM kame_connections WHERE holding_id = $1`, [holdingId]) as Promise<KameConnectionRow[]>,
			this.dataSource.query(`SELECT * FROM kame_company_settings WHERE holding_id = $1`, [holdingId]) as Promise<KameSettingsRow[]>,
			this.dataSource.query(
				`SELECT company_id::text AS company_id, environment, status, COUNT(*)::int AS n
				FROM erp_exports WHERE holding_id = $1 AND system = 'kame' GROUP BY 1, 2, 3`,
				[holdingId]
			),
			this.dataSource.query(`SELECT auto_enabled FROM holding_integration_settings WHERE holding_id = $1 AND integration = 'kame'`, [
				holdingId,
			]),
		]);

		return {
			/** Envío automático del holding (fila ausente = apagado para Kame). */
			auto_enabled: auto[0]?.auto_enabled === true,
			/** El job del servidor (`KAME_EXPORT_JOB_ENABLED`): apagado, nada se envía solo aunque el holding lo tenga prendido. */
			job_enabled: kameJobEnabled(),
			/** RUT de Kame permitidos en este entorno (vacío = cualquiera, producción). */
			allowed_ruts: allowedKameRuts(),
			/** `lista` (solo `allowed_ruts`), `abierto` (producción sin lista) o `cerrado` (fuera de producción sin lista: no escribe en ninguna empresa). */
			rut_guard: kameRutGuard(),
			data: companies.map((company: { id: string; legal_name: string; tax_id: string | null; has_odoo: boolean; dte_enabled: boolean }) => {
				const own = settings.find((row) => row.company_id === company.id);
				const environment = own?.active_environment ?? DEFAULT_SETTINGS.active_environment;
				const countsOf = (status: string) =>
					counts
						.filter(
							(row: { company_id: string; environment: string; status: string }) =>
								row.company_id === company.id && row.environment === environment && row.status === status
						)
						.reduce((sum: number, row: { n: number }) => sum + row.n, 0);

				return {
					company_id: company.id,
					company_name: company.legal_name,
					tax_id: company.tax_id,
					/** Con Odoo la compañía ya tiene ERP: no se conecta a Kame. */
					has_odoo: company.has_odoo,
					/** Emite documentos tributarios desde Sapira: solo esas facturas se registran en Kame. */
					dte_enabled: company.dte_enabled,
					settings: this.settingsView(own),
					connections: Object.fromEntries(
						KAME_ENVIRONMENTS.map((env) => [
							env,
							this.connectionView(connections.find((row) => row.company_id === company.id && row.environment === env)),
						])
					),
					exports: {
						pending: countsOf('pending') + countsOf('sending'),
						sent: countsOf('sent'),
						error: countsOf('error'),
						simulated: countsOf('simulated'),
					},
				};
			}),
		};
	}

	connectionView(row: KameConnectionRow | undefined | null) {
		if (!row) return null;
		let last4: string | null = null;

		try {
			last4 = secretLast4(this.encryption.decrypt(row.client_secret_encrypted));
		} catch {
			last4 = null;
		}

		return {
			environment: row.environment,
			client_id: row.client_id,
			has_secret: Boolean(row.client_secret_encrypted),
			secret_last4: last4,
			user_email: row.user_email,
			kame_company_rut: row.kame_company_rut,
			business_unit: row.business_unit,
			branch: row.branch,
			tested_at: row.tested_at,
			test_error: row.test_error,
			rut_allowed: isKameRutAllowed(row.kame_company_rut),
			updated_at: row.updated_at,
		};
	}

	settingsView(row: KameSettingsRow | undefined | null) {
		const value = { ...DEFAULT_SETTINGS, ...(row ?? {}) };

		return {
			active_environment: value.active_environment,
			active_environment_label: KAME_ENVIRONMENT_LABELS[value.active_environment],
			enabled: value.enabled,
			send_invoices: value.send_invoices,
			send_journal: value.send_journal,
			dry_run: value.dry_run,
			invoices_from: isoDate(value.invoices_from),
			journal_from: isoDate(value.journal_from),
		};
	}

	/** La compañía es del holding y es chilena (404 si no). Devuelve si tiene Odoo. */
	async assertCompany(holdingId: string, companyId: string): Promise<{ legal_name: string; has_odoo: boolean }> {
		const [company] = await this.dataSource.query(
			`SELECT legal_name, (odoo_integration_id IS NOT NULL) AS has_odoo, upper(COALESCE(country_code, country, '')) AS country
			FROM companies WHERE id = $1 AND holding_id = $2`,
			[companyId, holdingId]
		);

		if (!company) throw new NotFoundException('Compañía no encontrada');
		if (!['CL', 'CHILE'].includes(company.country)) throw new BadRequestException('Kame es un ERP chileno: solo se conectan compañías de Chile');

		return company;
	}

	async findConnection(holdingId: string, companyId: string, environment: KameEnvironment): Promise<KameConnectionRow | null> {
		const [row] = await this.dataSource.query(`SELECT * FROM kame_connections WHERE holding_id = $1 AND company_id = $2 AND environment = $3`, [
			holdingId,
			companyId,
			environment,
		]);

		return row ?? null;
	}

	async findSettings(holdingId: string, companyId: string): Promise<KameSettingsRow | null> {
		const [row] = await this.dataSource.query(`SELECT * FROM kame_company_settings WHERE holding_id = $1 AND company_id = $2`, [
			holdingId,
			companyId,
		]);

		return row ?? null;
	}

	/** Credencial descifrada de una conexión (para el cliente de Kame). */
	credentialOf(row: KameConnectionRow): KameCredential {
		return { key: row.id, clientId: row.client_id, clientSecret: this.encryption.decrypt(row.client_secret_encrypted) };
	}

	// ── Escritura ────────────────────────────────────────────────────────────────────────────────────────────────────────────

	async saveConnection(holdingId: string, companyId: string, environment: KameEnvironment, input: KameConnectionInput, userId: string | null) {
		const company = await this.assertCompany(holdingId, companyId);

		if (company.has_odoo) throw new ConflictException('La compañía ya envía sus facturas a Odoo: no se puede conectar también a Kame');
		const rut = normalizeKameRut(input.kame_company_rut);

		if (!/^\d{7,8}-[\dK]$/.test(rut))
			throw validationException([{ field: 'kame_company_rut', message: 'Escribe el RUT de la empresa en Kame (ej. 76.123.456-7)' }]);
		if (!isKameRutAllowed(rut)) {
			throw validationException([
				{
					field: 'kame_company_rut',
					message: allowedKameRuts().length
						? `Este entorno solo puede conectarse a la empresa de pruebas de Kame (${allowedKameRuts().join(', ')})`
						: 'Este entorno no tiene empresas de Kame permitidas: configura KAME_ALLOWED_RUTS con la empresa de pruebas',
				},
			]);
		}
		const existing = await this.findConnection(holdingId, companyId, environment);
		const secret = input.client_secret?.trim();

		if (!existing && !secret) throw validationException([{ field: 'client_secret', message: 'Escribe el client secret' }]);
		const encrypted = secret ? this.encryption.encrypt(secret) : existing!.client_secret_encrypted;
		const credentialChanged = !existing || existing.client_id !== input.client_id.trim() || Boolean(secret);

		await this.dataSource.query(
			`INSERT INTO kame_connections (holding_id, company_id, environment, client_id, client_secret_encrypted, user_email, kame_company_rut, business_unit, branch, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
			ON CONFLICT (company_id, environment) DO UPDATE SET client_id = EXCLUDED.client_id, client_secret_encrypted = EXCLUDED.client_secret_encrypted,
				user_email = EXCLUDED.user_email, kame_company_rut = EXCLUDED.kame_company_rut, business_unit = EXCLUDED.business_unit, branch = EXCLUDED.branch,
				updated_by = EXCLUDED.updated_by, updated_at = now()${credentialChanged ? ', tested_at = NULL, test_error = NULL' : ''}`,
			[
				holdingId,
				companyId,
				environment,
				input.client_id.trim(),
				encrypted,
				input.user_email.trim().toLowerCase(),
				rut,
				input.business_unit?.trim() || null,
				input.branch?.trim() || null,
				userId,
			]
		);
		if (existing) this.client.forgetToken(existing.id);

		return this.connectionView(await this.findConnection(holdingId, companyId, environment));
	}

	/** Prueba la conexión: pide el token y lista las unidades de negocio (y valida la elegida, si hay). Guarda el resultado. */
	async testConnection(holdingId: string, companyId: string, environment: KameEnvironment) {
		await this.assertCompany(holdingId, companyId);
		const row = await this.findConnection(holdingId, companyId, environment);

		if (!row) throw new NotFoundException(`La compañía no tiene conexión de ${KAME_ENVIRONMENT_LABELS[environment].toLowerCase()}`);
		let units: string[] = [];
		let error: string | null = null;

		try {
			this.client.forgetToken(row.id);
			units = businessUnitNames(await this.client.listBusinessUnits(this.credentialOf(row)));
			if (row.business_unit && units.length > 0 && !units.includes(row.business_unit)) {
				error = `La unidad de negocio «${row.business_unit}» no existe en Kame`;
			}
		} catch (e) {
			error = e instanceof KameApiError ? e.message : `No se pudo probar la conexión: ${(e as Error).message}`;
		}
		await this.dataSource.query(
			`UPDATE kame_connections SET tested_at = CASE WHEN $2::text IS NULL THEN now() ELSE tested_at END, test_error = $2 WHERE id = $1`,
			[row.id, error]
		);

		return { ok: error === null, message: error ?? 'Conexión con Kame correcta', business_units: units };
	}

	async deleteConnection(holdingId: string, companyId: string, environment: KameEnvironment) {
		await this.assertCompany(holdingId, companyId);
		const settings = await this.findSettings(holdingId, companyId);

		if (settings?.enabled && settings.active_environment === environment) {
			throw new ConflictException('Es la conexión activa de la compañía: apaga la conexión o cambia de ambiente antes de borrarla');
		}
		const [row] = await this.dataSource.query(
			`DELETE FROM kame_connections WHERE holding_id = $1 AND company_id = $2 AND environment = $3 RETURNING id`,
			[holdingId, companyId, environment]
		);

		if (!row) throw new NotFoundException('Conexión no encontrada');
		this.client.forgetToken(row.id);
	}

	/**
	 * Interruptores de la compañía. Prender la conexión exige la del ambiente activo probada. Al prender «Registrar facturas» sin fecha,
	 * se toma hoy (no se manda a Kame lo emitido antes); al prender «Enviar asientos» sin mes, el mes del último cierre.
	 */
	async updateSettings(holdingId: string, companyId: string, input: KameSettingsInput, userId: string | null) {
		await this.assertCompany(holdingId, companyId);
		const current = { ...DEFAULT_SETTINGS, ...((await this.findSettings(holdingId, companyId)) ?? {}) };
		const next = { ...current, ...this.clean(input) };

		if (next.enabled && !current.enabled) await this.assertReady(holdingId, companyId, next.active_environment);
		if (next.send_invoices && !next.invoices_from) next.invoices_from = today();
		if (next.send_journal && !next.journal_from) next.journal_from = await this.lastClosedMonth(holdingId, companyId);
		await this.upsertSettings(holdingId, companyId, next, userId);

		return this.settingsView(await this.findSettings(holdingId, companyId));
	}

	/**
	 * Cambia el ambiente activo. A producción exige su conexión probada y fija desde cuándo se envía (por defecto, hoy y el mes del último
	 * cierre): lo que se probó en la empresa de pruebas no se manda a la empresa real. Volver a pruebas siempre se puede.
	 */
	async switchEnvironment(holdingId: string, companyId: string, input: KameEnvironmentInput, userId: string | null) {
		await this.assertCompany(holdingId, companyId);
		const current = { ...DEFAULT_SETTINGS, ...((await this.findSettings(holdingId, companyId)) ?? {}) };

		if (current.active_environment === input.environment) {
			throw new ConflictException(`La compañía ya envía a ${KAME_ENVIRONMENT_LABELS[input.environment].toLowerCase()}`);
		}
		if (input.environment === 'produccion') await this.assertReady(holdingId, companyId, 'produccion');
		const next = {
			...current,
			active_environment: input.environment,
			invoices_from: input.invoices_from ?? today(),
			journal_from: input.journal_from ? monthStartOf(input.journal_from) : await this.lastClosedMonth(holdingId, companyId),
			// Al estrenar producción se parte en simulación: el primer envío real es a conciencia.
			dry_run: input.environment === 'produccion' ? true : current.dry_run,
		};

		await this.upsertSettings(holdingId, companyId, next, userId);

		return this.settingsView(await this.findSettings(holdingId, companyId));
	}

	/** Prende o apaga el envío automático del holding (`holding_integration_settings`, integración `kame`). */
	async setAuto(holdingId: string, enabled: boolean, userId: string | null) {
		await this.dataSource.query(
			`INSERT INTO holding_integration_settings (holding_id, integration, auto_enabled, updated_by)
			VALUES ($1, 'kame', $2, $3)
			ON CONFLICT (holding_id, integration) DO UPDATE SET auto_enabled = EXCLUDED.auto_enabled, updated_by = EXCLUDED.updated_by, updated_at = now()`,
			[holdingId, enabled, userId]
		);

		return { auto_enabled: enabled, job_enabled: kameJobEnabled() };
	}

	private clean(input: KameSettingsInput): Partial<KameSettingsRow> {
		const out: Partial<KameSettingsRow> = {};

		for (const key of ['enabled', 'send_invoices', 'send_journal', 'dry_run'] as const)
			if (typeof input[key] === 'boolean') out[key] = input[key];
		if (input.invoices_from !== undefined) out.invoices_from = input.invoices_from;
		if (input.journal_from !== undefined) out.journal_from = input.journal_from ? monthStartOf(input.journal_from) : null;

		return out;
	}

	private async assertReady(holdingId: string, companyId: string, environment: KameEnvironment) {
		const row = await this.findConnection(holdingId, companyId, environment);
		const label = KAME_ENVIRONMENT_LABELS[environment].toLowerCase();

		if (!row) throw new ConflictException(`Primero guarda la conexión de ${label}`);
		if (!row.tested_at || row.test_error) throw new ConflictException(`Prueba la conexión de ${label} antes de activarla`);
		if (!isKameRutAllowed(row.kame_company_rut)) throw new ConflictException('Este entorno solo puede enviar a la empresa de pruebas de Kame');
	}

	private async lastClosedMonth(holdingId: string, companyId: string): Promise<string | null> {
		const [row] = await this.dataSource.query(
			`SELECT to_char(cutoff_date, 'YYYY-MM-01') AS month FROM accounting_period_cutoff WHERE company_id = $1 AND holding_id = $2 LIMIT 1`,
			[companyId, holdingId]
		);

		return row?.month ?? null;
	}

	private async upsertSettings(
		holdingId: string,
		companyId: string,
		value: Omit<KameSettingsRow, 'company_id' | 'updated_at'>,
		userId: string | null
	) {
		await this.dataSource.query(
			`INSERT INTO kame_company_settings (company_id, holding_id, active_environment, enabled, send_invoices, send_journal, dry_run, invoices_from, journal_from, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10)
			ON CONFLICT (company_id) DO UPDATE SET active_environment = EXCLUDED.active_environment, enabled = EXCLUDED.enabled,
				send_invoices = EXCLUDED.send_invoices, send_journal = EXCLUDED.send_journal, dry_run = EXCLUDED.dry_run,
				invoices_from = EXCLUDED.invoices_from, journal_from = EXCLUDED.journal_from, updated_by = EXCLUDED.updated_by, updated_at = now()`,
			[
				companyId,
				holdingId,
				value.active_environment,
				value.enabled,
				value.send_invoices,
				value.send_journal,
				value.dry_run,
				isoDate(value.invoices_from),
				isoDate(value.journal_from),
				userId,
			]
		);
	}
}
