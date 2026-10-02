import * as fs from 'fs';
import * as path from 'path';

import { QueryRunner } from 'typeorm';

import { CompanyAccountMappingsFiveAccounts1790760000000 } from './migrations/1790760000000-CompanyAccountMappingsFiveAccounts';
import { ProductsStatus1790770000000 } from './migrations/1790770000000-ProductsStatus';
import { CountriesAndCompanyCountryCode1790780000000 } from './migrations/1790780000000-CountriesAndCompanyCountryCode';
import { CompanyLegalDocumentsStorage1790790000000 } from './migrations/1790790000000-CompanyLegalDocumentsStorage';
import { RolesIsDefault1790800000000 } from './migrations/1790800000000-RolesIsDefault';

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
});
