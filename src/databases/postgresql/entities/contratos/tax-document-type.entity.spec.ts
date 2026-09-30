import * as fs from 'fs';
import * as path from 'path';

import { DataSource, EntityMetadata } from 'typeorm';

import * as espejoExistentes from '../espejo.existing';
import * as espejoTodos from '../espejo.index';

import { Contract } from './contract.entity';
import { TAX_DOCUMENT_KINDS, TaxDocumentType } from './tax-document-type.entity';

/**
 * `tax_document_types` no es un espejo: nace por entity + migración `1790620000000-CreateTaxDocumentTypes` (GUIA → Crear
 * una tabla nueva), así que no tiene snapshot de prod que la mida. Este spec fija lo que la entity declara —y lo que la
 * migración escrita a mano tiene que crear— sin conectarse a ninguna base.
 */
describe('TaxDocumentType (entity + migración + seed)', () => {
	const dataSource = new DataSource({ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] });
	let metadata: EntityMetadata;
	let contract: EntityMetadata;

	beforeAll(async () => {
		await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
		metadata = dataSource.entityMetadatas.find((entry) => entry.target === TaxDocumentType)!;
		contract = dataSource.entityMetadatas.find((entry) => entry.target === Contract)!;
	});

	it('declara la tabla con sus columnas, PK, UNIQUE, CHECK e índice con los nombres reales', () => {
		expect(dataSource.isInitialized).toBe(false);
		expect(metadata.tableName).toBe('tax_document_types');
		expect(Object.fromEntries(metadata.columns.map((column) => [column.databaseName, column.isNullable]))).toEqual({
			id: false,
			country_code: false,
			code: false,
			name: false,
			kind: false,
			is_electronic: false,
			sort: false,
			active: false,
			created_at: false,
			// Migración 1790670000000-InvoiceDescriptionTemplate (spec facturas §3.6): NULL = sin límite.
			description_max_chars: true,
		});
		expect(metadata.primaryColumns.map((column) => column.databaseName)).toEqual(['id']);
		expect(Object.fromEntries(metadata.uniques.map((unique) => [unique.name, unique.columns.map((column) => column.databaseName)]))).toEqual({
			tax_document_types_country_code_code_key: ['country_code', 'code'],
		});
		expect(metadata.checks.map((check) => check.name)).toEqual(['tax_document_types_kind_check']);
		expect(metadata.checks[0].expression).toContain(`'invoice'::text`);
		expect(metadata.checks[0].expression).toContain(`'export_invoice'::text`);
		expect(Object.fromEntries(metadata.indices.map((index) => [index.name, index.columns.map((column) => column.databaseName)]))).toEqual({
			idx_tax_document_types_country_active: ['country_code', 'active'],
		});
		// Catálogo compartido: sin holding_id a propósito.
		expect(metadata.columns.some((column) => column.databaseName === 'holding_id')).toBe(false);
	});

	it('contracts referencia el catálogo con la FK y el índice declarados (columna opcional)', () => {
		const column = contract.columns.find((entry) => entry.databaseName === 'tax_document_type_id');
		const fk = contract.foreignKeys.find((entry) => entry.name === 'contracts_tax_document_type_id_fkey');

		expect(column?.isNullable).toBe(true);
		expect(fk?.referencedEntityMetadata.tableName).toBe('tax_document_types');
		expect(fk?.onDelete).toBe('NO ACTION');
		expect(contract.indices.some((index) => index.name === 'idx_contracts_tax_document_type_id')).toBe(true);
	});

	describe('migración 1790620000000-CreateTaxDocumentTypes', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '1790620000000-CreateTaxDocumentTypes.ts'), 'utf8');
		const up = source.slice(source.indexOf('async up('), source.indexOf('async down('));
		const down = source.slice(source.indexOf('async down('));

		it('crea la tabla con los mismos constraints que la entity y activa RLS (TypeORM no lo emite)', () => {
			expect(up).toContain('CREATE TABLE "tax_document_types"');
			expect(up).toContain('CONSTRAINT "tax_document_types_pkey" PRIMARY KEY ("id")');
			expect(up).toContain('CONSTRAINT "tax_document_types_country_code_code_key" UNIQUE ("country_code", "code")');
			expect(up).toContain('CONSTRAINT "tax_document_types_kind_check" CHECK');
			expect(up).toContain('CREATE INDEX "idx_tax_document_types_country_active"');
			expect(up).toContain('ALTER TABLE "tax_document_types" ENABLE ROW LEVEL SECURITY');
			for (const kind of TAX_DOCUMENT_KINDS) expect(up).toContain(`'${kind}'::text`);
		});

		it('agrega contracts.tax_document_type_id con FK e índice, y el down deshace en orden inverso sin tocar document_type', () => {
			expect(up).toContain('ALTER TABLE "contracts" ADD "tax_document_type_id" uuid');
			expect(up).toContain(
				'CONSTRAINT "contracts_tax_document_type_id_fkey" FOREIGN KEY ("tax_document_type_id") REFERENCES "tax_document_types"("id")'
			);
			expect(up).toContain('CREATE INDEX "idx_contracts_tax_document_type_id"');
			expect(up).not.toMatch(/DROP\s+(COLUMN|TABLE)/);
			expect(down.indexOf('DROP CONSTRAINT "contracts_tax_document_type_id_fkey"')).toBeLessThan(
				down.indexOf('DROP COLUMN "tax_document_type_id"')
			);
			expect(down.indexOf('DROP COLUMN "tax_document_type_id"')).toBeLessThan(down.indexOf('DROP TABLE "tax_document_types"'));
			expect(down).not.toContain('document_type"');
		});

		it('la clase declara el mismo name que su nombre (lo exige schema-status)', () => {
			expect(source).toContain('export class CreateTaxDocumentTypes1790620000000');
			expect(source).toContain(`name = 'CreateTaxDocumentTypes1790620000000'`);
		});
	});

	describe('seed 003-tax-document-types.sql', () => {
		const seed = fs.readFileSync(path.join(__dirname, '..', '..', 'seed', '003-tax-document-types.sql'), 'utf8');
		const rows = [...seed.matchAll(/\('([^']+)', '([^']+)', '([^']+)', '([^']+)', (TRUE|FALSE), (\d+), (\d+|NULL)\)/g)].map(
			([, country, code, name, kind, electronic, sort, maxChars]) => ({
				country,
				code,
				name,
				kind,
				electronic: electronic === 'TRUE',
				sort: Number(sort),
				max_chars: maxChars === 'NULL' ? null : Number(maxChars),
			})
		);

		it('es idempotente por (country_code, code) y no contiene transiciones', () => {
			const sql = seed
				.split('\n')
				.filter((line) => !line.trim().startsWith('--'))
				.join('\n');

			expect(sql).toContain('ON CONFLICT (country_code, code) DO NOTHING');
			expect(sql).not.toMatch(/\b(ALTER|UPDATE|DELETE|DROP)\b/);
		});

		it('carga los códigos acordados por país, con familias válidas y sin repetir (país, código)', () => {
			const byCountry = (country: string) => rows.filter((row) => row.country === country).map((row) => row.code);

			expect(byCountry('CL')).toEqual(['33', '34', '110', '61', '56', '111', '112']);
			expect(byCountry('PE')).toEqual(['01', '03', '07', '08']);
			expect(byCountry('MX')).toEqual(['CFDI-I', 'CFDI-E']);
			expect(byCountry('CO')).toEqual(['FE', 'NC']);
			expect(byCountry('*')).toEqual(['FACTURA', 'FACTURA_EXPORTACION']);
			expect(rows.every((row) => (TAX_DOCUMENT_KINDS as readonly string[]).includes(row.kind))).toBe(true);
			expect(new Set(rows.map((row) => `${row.country}|${row.code}`)).size).toBe(rows.length);
			// Familias que gobiernan document_type: exportación solo en 110 y el genérico.
			expect(rows.filter((row) => row.kind === 'export_invoice').map((row) => row.code)).toEqual(['110', 'FACTURA_EXPORTACION']);
			expect(rows.find((row) => row.code === '34')?.name).toBe('Factura no afecta o exenta electrónica');
			expect(rows.find((row) => row.code === '03')?.kind).toBe('receipt');
		});

		it('description_max_chars: 80 en todos los documentos de Chile (SII NmbItem) y sin límite en el resto (MX/PE a confirmar)', () => {
			expect(rows).toHaveLength(17);
			expect(rows.filter((row) => row.country === 'CL').every((row) => row.max_chars === 80)).toBe(true);
			expect(rows.filter((row) => row.country !== 'CL').every((row) => row.max_chars === null)).toBe(true);
		});
	});
});
