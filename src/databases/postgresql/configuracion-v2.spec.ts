import * as fs from 'fs';
import * as path from 'path';

import { QueryRunner } from 'typeorm';

import { CompanyAccountMappingsFiveAccounts1790760000000 } from './migrations/1790760000000-CompanyAccountMappingsFiveAccounts';
import { ProductsStatus1790770000000 } from './migrations/1790770000000-ProductsStatus';
import { CountriesAndCompanyCountryCode1790780000000 } from './migrations/1790780000000-CountriesAndCompanyCountryCode';
import { CompanyLegalDocumentsStorage1790790000000 } from './migrations/1790790000000-CompanyLegalDocumentsStorage';
import { RolesIsDefault1790800000000 } from './migrations/1790800000000-RolesIsDefault';
import { CompanyLogosBucketLimits1790810000000 } from './migrations/1790810000000-CompanyLogosBucketLimits';
import { TaxDocumentTypesTaxRate1790820000000 } from './migrations/1790820000000-TaxDocumentTypesTaxRate';
import { CustomFieldTypes1790830000000 } from './migrations/1790830000000-CustomFieldTypes';
import { ClientsCountryCode1790840000000 } from './migrations/1790840000000-ClientsCountryCode';
import { HoldingSettingsPreferencesV41790850000000 } from './migrations/1790850000000-HoldingSettingsPreferencesV4';

/**
 * Migraciones y assets de Configuración v2 (M2, M3, M4, M7, M8, M9), escritos a mano y **sin aplicar**: se verifica el SQL que emiten
 * sin conectarse a ninguna base.
 */
async function run(migration: { up: (q: QueryRunner) => Promise<void>; down: (q: QueryRunner) => Promise<void> }, direction: 'up' | 'down' = 'up') {
	const calls: { sql: string; params?: unknown[] }[] = [];
	const runner = {
		query: jest.fn(async (sql: string, params?: unknown[]) => {
			calls.push({ sql: sql.replace(/\s+/g, ' '), params });

			return [];
		}),
	} as unknown as QueryRunner;

	await migration[direction](runner);

	return calls;
}

const read = (relative: string) => fs.readFileSync(path.join(__dirname, relative), 'utf8');

describe('Configuración v2 · migraciones', () => {
	it('M2: seis columnas nullable en company_account_mappings, sin default', async () => {
		const calls = await run(new CompanyAccountMappingsFiveAccounts1790760000000());
		const adds = calls.filter((call) => call.sql.includes('ADD "'));

		expect(adds.map((call) => call.sql.match(/ADD "(\w+)"/)?.[1])).toEqual([
			'receivable_account_code',
			'receivable_account_name',
			'fx_difference_account_code',
			'fx_difference_account_name',
			'external_receivable_code',
			'external_fx_difference_code',
		]);
		expect(adds.every((call) => !/NOT NULL|DEFAULT/.test(call.sql))).toBe(true);
	});

	it('M3: products.status con default active y CHECK active|archived', async () => {
		const sql = (await run(new ProductsStatus1790770000000())).map((call) => call.sql).join('\n');

		expect(sql).toContain(`ADD "status" text NOT NULL DEFAULT 'active'`);
		expect(sql).toContain(`"products_status_check" CHECK (status = ANY (ARRAY['active'::text, 'archived'::text]))`);
	});

	it('M7: countries con RLS, 249 países sin repetir, FK desde companies y backfill con alias', async () => {
		const calls = await run(new CountriesAndCompanyCountryCode1790780000000());
		const sql = calls.map((call) => call.sql).join('\n');
		const seed = calls.find((call) => call.sql.includes('INSERT INTO "countries"'));
		const codes = (seed?.params?.[0] as string[]) ?? [];

		expect(sql).toContain('CREATE TABLE "countries"');
		expect(sql).toContain('ALTER TABLE "countries" ENABLE ROW LEVEL SECURITY');
		expect(codes).toHaveLength(249);
		expect(new Set(codes).size).toBe(249);
		expect(codes.every((code) => /^[A-Z]{2}$/.test(code))).toBe(true);
		const names = Object.fromEntries(
			codes.map((code, index) => [code, [(seed?.params?.[1] as string[])[index], (seed?.params?.[2] as string[])[index]]])
		);

		expect(names.MX).toEqual(['México', 'Mexico']);
		expect(names.PE).toEqual(['Perú', 'Peru']);
		expect(names.US).toEqual(['Estados Unidos', 'United States']);
		expect(sql).toContain('ADD "country_code" character(2)');
		expect(sql).toContain('REFERENCES "countries"("code") ON DELETE RESTRICT');
		expect(sql).toMatch(/UPDATE companies c SET country_code = n\.code/);
		const backfill = calls.find((call) => call.sql.includes('UPDATE companies c'));

		expect(backfill?.params?.[0]).toEqual(expect.arrayContaining(['eeuu', 'usa']));
	});

	it('M7 down borra lo que creó', async () => {
		const sql = (await run(new CountriesAndCompanyCountryCode1790780000000(), 'down')).map((call) => call.sql).join('\n');

		expect(sql).toContain('DROP COLUMN IF EXISTS "country_code"');
		expect(sql).toContain('DROP TABLE IF EXISTS "countries"');
	});

	it('M8: columnas de Storage nullable en company_legal_documents y bucket privado company-files', async () => {
		const sql = (await run(new CompanyLegalDocumentsStorage1790790000000())).map((call) => call.sql).join('\n');

		for (const column of ['storage_bucket', 'storage_path', 'file_name', 'mime_type', 'file_size', 'uploaded_by']) {
			expect(sql).toContain(`ALTER TABLE "company_legal_documents" ADD "${column}"`);
		}
		expect(sql).toContain(`VALUES ('company-files', 'company-files', false, 20971520`);
		expect(sql).toContain('ON DELETE SET NULL');
	});

	it('M9: roles.is_default + backfill de los 10 roles por defecto', async () => {
		const calls = await run(new RolesIsDefault1790800000000());
		const backfill = calls.find((call) => call.sql.includes('UPDATE "roles"'));

		expect(calls[0].sql).toContain('ADD "is_default" boolean NOT NULL DEFAULT false');
		expect(backfill?.params?.[0]).toEqual([
			'Administrador',
			'Invitado',
			'Ventas',
			'Operaciones',
			'Revenue Ops',
			'BI',
			'Facturación y Cobranza',
			'Finanzas',
			'Admin de Negocio',
			'Admin Técnico',
		]);
	});
});

describe('Configuración v2 · bucket de logos', () => {
	it('company-logos: 2 MB y solo PNG, JPG, WEBP (sin SVG); down lo deja sin límites', async () => {
		const up = (await run(new CompanyLogosBucketLimits1790810000000())).map((call) => call.sql).join('\n');
		const down = (await run(new CompanyLogosBucketLimits1790810000000(), 'down')).map((call) => call.sql).join('\n');

		expect(up).toContain(`SET file_size_limit = 2097152, allowed_mime_types = ARRAY['image/png', 'image/jpeg', 'image/webp']`);
		expect(up).toContain(`WHERE id = 'company-logos'`);
		expect(up).not.toContain('svg');
		expect(down).toContain('file_size_limit = NULL, allowed_mime_types = NULL');
	});
});

describe('Configuración v2 · assets', () => {
	it('M4: el seed registra CLOSE_PERIODS y lo asigna idempotente a Administrador y Finanzas', () => {
		const seed = read('seed/004-close-periods-permission.sql');

		expect(seed).toContain(`VALUES ('CLOSE_PERIODS', 'Cerrar y reabrir períodos contables')`);
		expect(seed).toContain('ON CONFLICT (code) DO NOTHING');
		expect(seed).toContain(`r.name IN ('Administrador', 'Finanzas')`);
		expect(seed).toContain('NOT EXISTS');
	});

	it('create_default_roles_for_holding: los 10 roles nacen is_default y CLOSE_PERIODS va a Administrador y Finanzas', () => {
		const fn = read('functions/create_default_roles_for_holding.sql');

		expect(fn.match(/NEW\.id, NOW\(\), true\)/g)).toHaveLength(10);
		expect(fn.match(/'CLOSE_PERIODS'/g)).toHaveLength(2);
	});

	it('create_default_roles_for_holding: Finanzas entra a Configuración (solo VIEW) y sin ADMIN_FULL_ACCESS (no está en el catálogo)', () => {
		const fn = read('functions/create_default_roles_for_holding.sql');
		const finanzas = fn.slice(fn.indexOf('-- Insertar permisos para Finanzas'), fn.indexOf('-- Insertar permisos para Admin de Negocio'));

		expect(finanzas).toContain(`'VIEW_CONFIGURACION'`);
		expect(finanzas).not.toContain('EDIT_CONFIGURACION');
		expect(fn).not.toMatch(/'ADMIN_FULL_ACCESS'/);
	});

	it('seed 005: VIEW_CONFIGURACION al rol por defecto Finanzas de todos los holdings, idempotente', () => {
		const seed = read('seed/005-finanzas-view-configuracion.sql');

		expect(seed).toContain(`p.code = 'VIEW_CONFIGURACION'`);
		expect(seed).toContain(`r.is_default = true`);
		expect(seed).toContain(`r.name = 'Finanzas'`);
		expect(seed).toContain('NOT EXISTS');
	});
});

describe('Configuración v2 · ronda 3 (M11, M12, M13, seed 006)', () => {
	it('M11: tax_rate nullable con CHECK 0–100 y las tasas de Domi (CO FE = 0); sin tabla por compañía', async () => {
		const calls = await run(new TaxDocumentTypesTaxRate1790820000000());
		const sql = calls.map((call) => call.sql).join('\n');
		const update = calls.find((call) => call.sql.includes('UPDATE "tax_document_types"'));
		const [countries, codes, rates] = update?.params as [string[], string[], number[]];
		const byDoc = Object.fromEntries(codes.map((code, index) => [`${countries[index]} ${code}`, rates[index]]));

		expect(sql).toContain('ALTER TABLE "tax_document_types" ADD "tax_rate" numeric');
		expect(sql).toContain('"tax_document_types_tax_rate_check" CHECK ("tax_rate" IS NULL OR ("tax_rate" >= 0 AND "tax_rate" <= 100))');
		expect(byDoc).toEqual({
			'CL 33': 19,
			'CL 34': 0,
			'CL 110': 0,
			'CL 111': 0,
			'CL 112': 0,
			'PE 01': 18,
			'PE 03': 18,
			'MX CFDI-I': 16,
			'CO FE': 0,
		});
		expect(sql).not.toContain('company_tax_document_types');
		const seed = read('seed/006-tax-document-types-tax-rate.sql');

		expect(seed).toContain("('CO', 'FE', 0::numeric)");
		expect(seed).toContain('t.tax_rate IS NULL');
	});

	it('M12: options jsonb y CHECK de tipos ampliado (text, number, select, boolean, date) + options solo en select', async () => {
		const sql = (await run(new CustomFieldTypes1790830000000())).map((call) => call.sql).join('\n');

		expect(sql).toContain('ADD "options" jsonb');
		expect(sql).toContain("ARRAY['text'::text, 'number'::text, 'select'::text, 'boolean'::text, 'date'::text]");
		expect(sql).toContain('"custom_field_definitions_options_check" CHECK ((field_type = \'select\') = (options IS NOT NULL');
	});

	it('M13: country_code en clients y client_entities con FK a countries, backfill tolerante (espacio duro, alias) y log de lo que no calza', async () => {
		const calls = await run(new ClientsCountryCode1790840000000());
		const sql = calls.map((call) => call.sql).join('\n');

		for (const table of ['clients', 'client_entities']) {
			expect(sql).toContain(`ALTER TABLE "${table}" ADD "country_code" character(2)`);
			expect(sql).toContain(`"${table}_country_code_fkey" FOREIGN KEY ("country_code") REFERENCES "countries"("code") ON DELETE RESTRICT`);
			expect(sql).toContain(`UPDATE "${table}" t SET country_code = n.code`);
		}
		expect(sql).toContain('chr(160)');
		const backfill = calls.find((call) => call.sql.includes('UPDATE "clients" t'));

		expect(backfill?.params?.[0]).toEqual(expect.arrayContaining(['eeuu', 'usa', 'republica dominicana', 'emiratos arabes']));
		expect((await run(new ClientsCountryCode1790840000000(), 'down')).map((call) => call.sql).join('\n')).toContain(
			'DROP COLUMN IF EXISTS "country_code"'
		);
	});
});

describe('Configuración v2 · ronda 4 (M14)', () => {
	it('M14: columnas de holding_settings con defaults = comportamiento actual y sus CHECK; down las quita', async () => {
		const sql = (await run(new HoldingSettingsPreferencesV41790850000000())).map((call) => call.sql).join('\n');

		expect(sql).toContain(`ADD "timezone" text NOT NULL DEFAULT 'America/Santiago'`);
		// Horizonte fijo en 12 por sistema (Domi 03-10): no es columna.
		expect(sql).not.toContain('indefinite_horizon_periods');
		expect(sql).toContain(`ADD "renewal_reminder_days" smallint[] NOT NULL DEFAULT '{15,7,0}'`);
		expect(sql).toContain('ADD "renewal_overdue_every_days" smallint NOT NULL DEFAULT 7');
		expect(sql).toContain(`ADD "quote_numbering_mode" text NOT NULL DEFAULT 'prefixed'`);
		expect(sql).toContain(`ADD "quote_number_prefix" text NOT NULL DEFAULT 'COT'`);
		expect(sql).toContain('ADD "quote_number_include_year" boolean NOT NULL DEFAULT true');
		expect(sql).toContain('ADD "quote_number_width" smallint NOT NULL DEFAULT 4');
		expect(sql).not.toMatch(/UPDATE|DROP COLUMN|DELETE/);
		const down = (await run(new HoldingSettingsPreferencesV41790850000000(), 'down')).map((call) => call.sql).join('\n');

		for (const column of ['timezone', 'renewal_reminder_days', 'quote_numbering_mode', 'quote_number_width']) {
			expect(down).toContain(`DROP COLUMN IF EXISTS "${column}"`);
		}
	});
});
