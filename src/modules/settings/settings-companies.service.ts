import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';

import { ACCOUNT_KEYS } from './dtos/companies.dto';
import { assertCompanyInHolding, assertCurrency, joinEs, plural, Queryable, Row, toCount, toNumber } from './settings-common';
import { assertLogoUrl, prepareLogoUpload } from './settings-holding.service';
import { SettingsStorageService } from './settings-storage.service';

import type {
	AccountKey,
	CreateBankAccountDto,
	CreateCompanyDto,
	PutAccountsDto,
	UpdateBankAccountDto,
	UpdateCompanyDto,
} from './dtos/companies.dto';
import type { LogoUploadDto } from './dtos/holding.dto';

/** Columnas de `companies` que el front nuevo lee y escribe. */
const COMPANY_COLUMNS = `c.id, c.legal_name, c.tax_id, c.country_code, c.country, c.legal_address, c.representative_name, c.email, c.phone,
	c.website, c.invoice_prefix, c.contract_prefix, c.tax_rate, c.currency, c.logo_url, c.odoo_integration_id, c.created_at`;

/** Campos de texto que se copian tal cual del DTO. */
const TEXT_FIELDS = [
	'legal_name',
	'tax_id',
	'legal_address',
	'representative_name',
	'email',
	'phone',
	'website',
	'invoice_prefix',
	'contract_prefix',
	'logo_url',
] as const;

/**
 * Lo que impide borrar una compañía: FKs `RESTRICT`/`NO ACTION` hacia `companies` (producción, 02-10) y las que borrarían datos en
 * cascada (`mrr_adjustments`, `invoices_legacy`), más `sii_configurations` (sin FK). `quotes` no tiene `company_id`.
 */
const COMPANY_DEPENDENCIES: { key: string; label: [string, string]; sql: string }[] = [
	{ key: 'contracts', label: ['contrato', 'contratos'], sql: `SELECT count(*) AS n FROM contracts WHERE company_id = $1` },
	{ key: 'invoices', label: ['factura', 'facturas'], sql: `SELECT count(*) AS n FROM invoices WHERE company_id = $1` },
	{
		key: 'period_events',
		label: ['cierre de período', 'cierres de período'],
		sql: `SELECT (SELECT count(*) FROM accounting_period_cutoff WHERE company_id = $1) + (SELECT count(*) FROM accounting_period_events WHERE company_id = $1) AS n`,
	},
	{
		key: 'bank_movements',
		label: ['movimiento o carga de cartola', 'movimientos o cargas de cartola'],
		sql: `SELECT (SELECT count(*) FROM bank_movements WHERE company_id = $1) + (SELECT count(*) FROM bank_upload_batches WHERE company_id = $1) AS n`,
	},
	{ key: 'subscriptions', label: ['suscripción', 'suscripciones'], sql: `SELECT count(*) AS n FROM subscriptions WHERE company_id = $1` },
	{
		key: 'other',
		label: [
			'otro registro (devengo, legado, plantillas, agentes, integraciones o SII)',
			'otros registros (devengo, legado, plantillas, agentes, integraciones o SII)',
		],
		sql: `SELECT (SELECT count(*) FROM revenue_schedule_monthly WHERE company_id = $1)
			+ (SELECT count(*) FROM mrr_adjustments WHERE company_id = $1)
			+ (SELECT count(*) FROM mrr_legacy WHERE company_id = $1)
			+ (SELECT count(*) FROM invoices_legacy WHERE company_id = $1)
			+ (SELECT count(*) FROM contract_templates WHERE company_id = $1)
			+ (SELECT count(*) FROM contract_clauses WHERE company_id = $1)
			+ (SELECT count(*) FROM agents WHERE company_id = $1)
			+ (SELECT count(*) FROM revenue_rules WHERE company_id = $1)
			+ (SELECT count(*) FROM integration_configs WHERE company_id = $1)
			+ (SELECT count(*) FROM contract_billing_splits WHERE billing_company_id = $1)
			+ (SELECT count(*) FROM sii_configurations WHERE company_id = $1) AS n`,
	},
];

/** Las 5 cuentas del asiento (spec §1.3) → columnas de `company_account_mappings`. */
const ACCOUNTS: Record<AccountKey, { label: string; code: string; name: string; external: string }> = {
	receivable: {
		label: 'Cuentas por cobrar',
		code: 'receivable_account_code',
		name: 'receivable_account_name',
		external: 'external_receivable_code',
	},
	deferred: { label: 'Ingresos diferidos', code: 'deferred_account_code', name: 'deferred_account_name', external: 'external_deferred_code' },
	unbilled: { label: 'Ingresos por facturar', code: 'unbilled_account_code', name: 'unbilled_account_name', external: 'external_unbilled_code' },
	revenue: { label: 'Ingresos', code: 'revenue_account_code', name: 'revenue_account_name', external: 'external_revenue_code' },
	fx_difference: {
		label: 'Diferencia de cambio',
		code: 'fx_difference_account_code',
		name: 'fx_difference_account_name',
		external: 'external_fx_difference_code',
	},
};

/** `tax_rate` siempre en porcentaje: las filas antiguas en fracción (`0.19`) se devuelven como `19` (spec §8). */
export function normalizeTaxRate(value: unknown): number | null {
	const rate = toNumber(value);

	if (rate === null) return null;

	return rate > 0 && rate < 1 ? Math.round(rate * 100 * 10_000) / 10_000 : rate;
}

const companyDto = (row: Row) => ({
	id: String(row.id),
	legal_name: (row.legal_name as string | null) ?? null,
	tax_id: (row.tax_id as string | null) ?? null,
	country_code: (row.country_code as string | null)?.trim() ?? null,
	country: (row.country as string | null) ?? null,
	legal_address: (row.legal_address as string | null) ?? null,
	representative_name: (row.representative_name as string | null) ?? null,
	email: (row.email as string | null) ?? null,
	phone: (row.phone as string | null) ?? null,
	website: (row.website as string | null) ?? null,
	invoice_prefix: (row.invoice_prefix as string | null) ?? null,
	contract_prefix: (row.contract_prefix as string | null) ?? null,
	tax_rate: normalizeTaxRate(row.tax_rate),
	currency: (row.currency as string | null) ?? null,
	logo_url: (row.logo_url as string | null) ?? null,
	erp_linked: row.odoo_integration_id !== null && row.odoo_integration_id !== undefined,
	odoo_integration_id: toNumber(row.odoo_integration_id),
	created_at: row.created_at,
});

const bankAccountDto = (row: Row) => ({
	id: String(row.id),
	company_id: String(row.company_id),
	bank_name: String(row.bank_name),
	account_type: String(row.account_type),
	account_number: String(row.account_number),
	currency: String(row.currency),
	account_holder: (row.account_holder as string | null) ?? null,
	created_at: row.created_at,
	in_use: toCount(row.in_use),
});

/** Nombre en español del país (catálogo `countries`, M7). 400 si el código no existe. */
export async function countryName(db: Queryable, code: string): Promise<string> {
	const [row] = (await db.query(`SELECT name_es FROM countries WHERE code = $1`, [code.toUpperCase()])) as Row[];

	if (!row) throw validationException([{ field: 'country_code', message: `País no reconocido: ${code.toUpperCase()}` }]);

	return String(row.name_es);
}

/**
 * Compañía 360 de Configuración: datos de la compañía, las 5 cuentas contables y las cuentas bancarias. La compañía siempre se busca
 * por `id` **y** `holding_id` (404 si no); `company_account_mappings` y `company_bank_accounts` se acotan por la compañía.
 */
@Injectable()
export class SettingsCompaniesService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly storage: SettingsStorageService
	) {}

	async list(holdingId: string) {
		const rows = (await this.dataSource.query(
			`SELECT ${COMPANY_COLUMNS} FROM companies c WHERE c.holding_id = $1 ORDER BY c.legal_name NULLS LAST, c.created_at`,
			[holdingId]
		)) as Row[];

		return rows.map(companyDto);
	}

	private async findRow(holdingId: string, id: string): Promise<Row> {
		const [row] = (await this.dataSource.query(`SELECT ${COMPANY_COLUMNS} FROM companies c WHERE c.id = $1 AND c.holding_id = $2`, [
			id,
			holdingId,
		])) as Row[];

		if (!row) throw new NotFoundException('Compañía no encontrada');

		return row;
	}

	async usage(companyId: string): Promise<Record<string, number>> {
		const usage: Record<string, number> = {};

		for (const dependency of COMPANY_DEPENDENCIES) {
			const [row] = (await this.dataSource.query(dependency.sql, [companyId])) as Row[];

			usage[dependency.key] = toCount(row?.n);
		}

		return usage;
	}

	async get(holdingId: string, id: string) {
		const company = companyDto(await this.findRow(holdingId, id));
		const usage = await this.usage(id);

		return { ...company, usage, can_delete: Object.values(usage).every((count) => count === 0) };
	}

	async create(holdingId: string, dto: CreateCompanyDto) {
		const [holding] = (await this.dataSource.query(`SELECT name FROM company_holdings WHERE id = $1`, [holdingId])) as Row[];

		if (!holding) throw new NotFoundException('Holding no encontrado');
		const currency = await assertCurrency(this.dataSource, dto.currency);
		const country = await countryName(this.dataSource, dto.country_code);
		const [row] = (await this.dataSource.query(
			`INSERT INTO companies (holding_id, holding_name, legal_name, tax_id, country_code, country, currency, legal_address, representative_name,
				email, phone, website, invoice_prefix, contract_prefix, tax_rate)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
			RETURNING id`,
			[
				holdingId,
				holding.name,
				dto.legal_name,
				dto.tax_id ?? null,
				dto.country_code,
				country,
				currency,
				dto.legal_address ?? null,
				dto.representative_name ?? null,
				dto.email ?? null,
				dto.phone ?? null,
				dto.website ?? null,
				dto.invoice_prefix ?? null,
				dto.contract_prefix ?? null,
				dto.tax_rate ?? null,
			]
		)) as Row[];

		return companyDto(await this.findRow(holdingId, String(row.id)));
	}

	async update(holdingId: string, id: string, dto: UpdateCompanyDto) {
		const current = await this.findRow(holdingId, id);
		const sets: string[] = [];
		const params: unknown[] = [id, holdingId];
		const set = (column: string, value: unknown) => sets.push(`${column} = $${params.push(value)}`);

		assertLogoUrl(this.storage, `companies/${id}`, dto.logo_url, current.logo_url);
		for (const field of TEXT_FIELDS) if (dto[field] !== undefined) set(field, dto[field]);
		if (dto.tax_rate !== undefined) set('tax_rate', dto.tax_rate);
		if (dto.country_code !== undefined) {
			set('country_code', dto.country_code);
			set('country', await countryName(this.dataSource, dto.country_code));
		}
		if (dto.currency !== undefined) {
			const currency = await assertCurrency(this.dataSource, dto.currency);

			if (currency !== current.currency) {
				// `trigger_sync_contracts_company_currency` reescribiría `contracts.company_currency` de todos sus contratos.
				const usage = await this.usage(id);

				if (usage.contracts > 0 || usage.invoices > 0) {
					const parts = [
						usage.contracts ? plural(usage.contracts, 'contrato', 'contratos') : '',
						usage.invoices ? plural(usage.invoices, 'factura', 'facturas') : '',
					].filter(Boolean);

					throw new ConflictException(`No se puede cambiar la moneda: la compañía ya tiene ${joinEs(parts)}`);
				}
			}
			set('currency', currency);
		}
		if (sets.length) await this.dataSource.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $1 AND holding_id = $2`, params);

		return companyDto(await this.findRow(holdingId, id));
	}

	async remove(holdingId: string, id: string): Promise<void> {
		await this.findRow(holdingId, id);
		const usage = await this.usage(id);
		const blockers = COMPANY_DEPENDENCIES.filter((dependency) => usage[dependency.key] > 0).map((dependency) =>
			plural(usage[dependency.key], dependency.label[0], dependency.label[1])
		);

		if (blockers.length) throw new ConflictException(`No se puede eliminar: la compañía tiene ${joinEs(blockers)}`);
		// Cuentas bancarias, documentos legales y cuentas contables se borran en cascada (FK ON DELETE CASCADE).
		await this.dataSource.query(`DELETE FROM companies WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}

	async prepareLogoUpload(holdingId: string, id: string, input: LogoUploadDto) {
		await this.findRow(holdingId, id);

		return prepareLogoUpload(this.storage, `companies/${id}`, input);
	}

	// ── Cuentas contables ───────────────────────────────────────────────────────────────────────────────────────────────────────

	async getAccounts(holdingId: string, companyId: string) {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		const [mapping] = (await this.dataSource.query(`SELECT * FROM company_account_mappings WHERE company_id = $1`, [companyId])) as Row[];
		const accounts = ACCOUNT_KEYS.map((key) => {
			const columns = ACCOUNTS[key];
			const value = (column: string) => {
				const raw = mapping?.[column];

				return typeof raw === 'string' && raw.trim() !== '' ? raw : null;
			};

			return { key, label: columns.label, code: value(columns.code), name: value(columns.name), external_code: value(columns.external) };
		});

		return {
			company_id: companyId,
			configured: !!mapping,
			complete: !!mapping && accounts.every((account) => account.code && account.name),
			accounts,
		};
	}

	async putAccounts(holdingId: string, companyId: string, dto: PutAccountsDto) {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		const seen = new Set<string>();

		for (const account of dto.accounts) {
			if (!(ACCOUNT_KEYS as readonly string[]).includes(account.key)) {
				throw validationException([{ field: 'accounts', message: `Clave de cuenta no válida: ${account.key}` }]);
			}
			if (seen.has(account.key)) throw validationException([{ field: 'accounts', message: `Cuenta repetida: ${account.key}` }]);
			seen.add(account.key);
		}
		const missing = ACCOUNT_KEYS.filter((key) => !seen.has(key));

		if (missing.length) throw validationException([{ field: 'accounts', message: `Faltan cuentas: ${missing.join(', ')}` }]);
		const columns: string[] = [];
		const values: unknown[] = [];

		for (const account of dto.accounts) {
			const target = ACCOUNTS[account.key as AccountKey];

			columns.push(target.code, target.name, target.external);
			values.push(account.code, account.name, account.external_code ?? null);
		}
		const placeholders = values.map((_, index) => `$${index + 2}`).join(', ');
		const updates = columns.map((column) => `${column} = EXCLUDED.${column}`).join(', ');

		await this.dataSource.query(
			`INSERT INTO company_account_mappings (company_id, ${columns.join(', ')}) VALUES ($1, ${placeholders})
			ON CONFLICT (company_id) DO UPDATE SET ${updates}, updated_at = now()`,
			[companyId, ...values]
		);

		return this.getAccounts(holdingId, companyId);
	}

	// ── Cuentas bancarias ───────────────────────────────────────────────────────────────────────────────────────────────────────

	private readonly bankSelect = `SELECT a.*, (SELECT count(*) FROM bank_upload_batches b WHERE b.bank_account_id = a.id) AS in_use FROM company_bank_accounts a`;

	async listBankAccounts(holdingId: string, companyId: string) {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		const rows = (await this.dataSource.query(
			`${this.bankSelect} WHERE a.company_id = $1 AND a.holding_id = $2 ORDER BY a.bank_name, a.account_number`,
			[companyId, holdingId]
		)) as Row[];

		return rows.map(bankAccountDto);
	}

	private async findBankAccount(holdingId: string, companyId: string, accountId: string): Promise<Row> {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		const [row] = (await this.dataSource.query(`${this.bankSelect} WHERE a.id = $1 AND a.company_id = $2 AND a.holding_id = $3`, [
			accountId,
			companyId,
			holdingId,
		])) as Row[];

		if (!row) throw new NotFoundException('Cuenta bancaria no encontrada');

		return row;
	}

	private async assertBankAccountFree(companyId: string, bankName: string, accountNumber: string, excludeId: string | null) {
		const rows = (await this.dataSource.query(
			`SELECT 1 FROM company_bank_accounts WHERE company_id = $1 AND lower(bank_name) = lower($2)
				AND regexp_replace(account_number, '[^0-9A-Za-z]', '', 'g') = regexp_replace($3, '[^0-9A-Za-z]', '', 'g')
				AND id IS DISTINCT FROM $4::uuid LIMIT 1`,
			[companyId, bankName, accountNumber, excludeId]
		)) as Row[];

		if (rows.length) throw new ConflictException('Ya existe esa cuenta (banco y número) en esta compañía');
	}

	async createBankAccount(holdingId: string, companyId: string, dto: CreateBankAccountDto) {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		const currency = await assertCurrency(this.dataSource, dto.currency);

		await this.assertBankAccountFree(companyId, dto.bank_name, dto.account_number, null);
		const [row] = (await this.dataSource.query(
			`INSERT INTO company_bank_accounts (company_id, holding_id, bank_name, account_type, account_number, currency, account_holder)
			VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
			[companyId, holdingId, dto.bank_name, dto.account_type, dto.account_number, currency, dto.account_holder ?? null]
		)) as Row[];

		return bankAccountDto(await this.findBankAccount(holdingId, companyId, String(row.id)));
	}

	async updateBankAccount(holdingId: string, companyId: string, accountId: string, dto: UpdateBankAccountDto) {
		const current = await this.findBankAccount(holdingId, companyId, accountId);
		const next = {
			bank_name: dto.bank_name ?? String(current.bank_name),
			account_type: dto.account_type ?? String(current.account_type),
			account_number: dto.account_number ?? String(current.account_number),
			currency: dto.currency ? await assertCurrency(this.dataSource, dto.currency) : String(current.currency),
			account_holder: dto.account_holder === undefined ? ((current.account_holder as string | null) ?? null) : dto.account_holder,
		};

		if (dto.bank_name !== undefined || dto.account_number !== undefined) {
			await this.assertBankAccountFree(companyId, next.bank_name, next.account_number, accountId);
		}
		await this.dataSource.query(
			`UPDATE company_bank_accounts SET bank_name = $3, account_type = $4, account_number = $5, currency = $6, account_holder = $7
			WHERE id = $1 AND company_id = $2`,
			[accountId, companyId, next.bank_name, next.account_type, next.account_number, next.currency, next.account_holder]
		);

		return bankAccountDto(await this.findBankAccount(holdingId, companyId, accountId));
	}

	async deleteBankAccount(holdingId: string, companyId: string, accountId: string): Promise<void> {
		const account = await this.findBankAccount(holdingId, companyId, accountId);
		const batches = toCount(account.in_use);

		if (batches > 0) {
			throw new ConflictException(`Esta cuenta tiene ${plural(batches, 'carga de cartola', 'cargas de cartola')}: no se puede eliminar`);
		}
		await this.dataSource.query(`DELETE FROM company_bank_accounts WHERE id = $1 AND company_id = $2`, [accountId, companyId]);
	}
}
