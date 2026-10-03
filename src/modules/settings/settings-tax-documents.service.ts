import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { GENERIC_TAX_COUNTRY } from '@/databases/postgresql/entities/contratos/tax-document-type.entity';
import { normalizeCountry, normalizeTaxRate, resolveTaxRate } from '@/modules/contracts/billing-engine';

import { Row, toCount, toNumber } from './settings-common';

/**
 * Documentos tributarios de la compañía (Configuración v2 ronda 3, contrato §8.1) — **solo lectura** (decisión de Domi 03-10: sin
 * activación por compañía). Los del país de la compañía (todas las familias) o, si el país no tiene propios, los genéricos `*`, con la
 * tasa del catálogo (`tax_document_types.tax_rate`), la tasa efectiva según la regla del motor (`resolveTaxRate`) y el uso en contratos.
 */
@Injectable()
export class SettingsTaxDocumentsService {
	constructor(private readonly dataSource: DataSource) {}

	async get(holdingId: string, companyId: string) {
		const [company] = (await this.dataSource.query(
			`SELECT id, country_code, country, tax_rate FROM companies WHERE id = $1 AND holding_id = $2`,
			[companyId, holdingId]
		)) as Row[];

		if (!company) throw new NotFoundException('Compañía no encontrada');
		const countryCode = (company.country_code as string | null)?.trim() || normalizeCountry(company.country as string | null) || null;
		const rows = (await this.dataSource.query(
			`SELECT t.id, t.country_code, t.code, t.name, t.kind, t.is_electronic, t.sort, t.tax_rate,
				(SELECT count(*) FROM contracts c WHERE c.company_id = $1 AND c.tax_document_type_id = t.id AND c.deleted_at IS NULL) AS in_use,
				(SELECT count(*) FROM contracts c WHERE c.company_id = $1 AND c.tax_document_type_id = t.id AND c.deleted_at IS NULL
					AND c.status IS DISTINCT FROM 'Cancelado') AS in_use_open
			FROM tax_document_types t
			WHERE t.active = true AND t.country_code = ANY($2::text[])
			ORDER BY t.sort, t.code`,
			[companyId, [countryCode ?? GENERIC_TAX_COUNTRY, GENERIC_TAX_COUNTRY]]
		)) as Row[];
		const own = rows.filter((row) => countryCode && row.country_code === countryCode);
		const generic = !own.length;
		const companyTaxRate = company.tax_rate as number | string | null;

		return {
			company_id: String(company.id),
			country_code: countryCode,
			company_tax_rate: normalizeTaxRate(companyTaxRate),
			generic,
			documents: (generic ? rows.filter((row) => row.country_code === GENERIC_TAX_COUNTRY) : own).map((row) => {
				const kind = String(row.kind);
				const taxRate = toNumber(row.tax_rate);
				const tax = resolveTaxRate({
					documentType: kind === 'export_invoice' ? 'FACTURA_EXPORTACION' : 'FACTURA',
					companyCountry: countryCode,
					companyTaxRate,
					document: { kind, tax_rate: taxRate },
				});

				return {
					id: String(row.id),
					country_code: String(row.country_code),
					code: String(row.code),
					name: String(row.name ?? ''),
					kind,
					is_electronic: row.is_electronic === true,
					tax_rate: taxRate,
					effective_tax_rate: tax.rule === 'colombia_erp' ? null : tax.rate,
					tax_rule: tax.rule,
					in_use: toCount(row.in_use),
					in_use_open: toCount(row.in_use_open),
				};
			}),
		};
	}
}
