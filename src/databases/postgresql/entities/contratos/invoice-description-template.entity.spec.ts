import * as fs from 'fs';
import * as path from 'path';

import { DataSource, EntityMetadata } from 'typeorm';

import * as espejoExistentes from '../espejo.existing';
import * as espejoTodos from '../espejo.index';
import { InvoiceItem } from '../facturacion/invoice-item.entity';

import { Contract } from './contract.entity';
import { TaxDocumentType } from './tax-document-type.entity';

/**
 * Facturas en el Contrato 360 · etapa 3 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.6): las tres columnas nuevas nacen por
 * entity + migración `1790670000000-InvoiceDescriptionTemplate`. Este spec fija lo que declaran las entities y lo que la migración escrita
 * a mano tiene que crear, sin conectarse a ninguna base.
 */
describe('Constructor de descripción (entities + migración 1790670000000)', () => {
	const dataSource = new DataSource({ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] });
	const byTarget = new Map<unknown, EntityMetadata>();
	const column = (target: unknown, name: string) => byTarget.get(target)!.columns.find((entry) => entry.databaseName === name);

	beforeAll(async () => {
		await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
		for (const entry of dataSource.entityMetadatas) byTarget.set(entry.target, entry);
	});

	it('declara las tres columnas con su tipo, nulabilidad y default', () => {
		expect(dataSource.isInitialized).toBe(false);
		expect(column(Contract, 'invoice_description_template')).toMatchObject({ type: 'jsonb', isNullable: true });
		expect(column(InvoiceItem, 'description_locked')).toMatchObject({ type: 'boolean', isNullable: false, default: false });
		expect(column(TaxDocumentType, 'description_max_chars')).toMatchObject({ type: 'integer', isNullable: true });
	});

	describe('migración', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '1790670000000-InvoiceDescriptionTemplate.ts'), 'utf8');
		const up = source.slice(source.indexOf('async up('), source.indexOf('async down('));
		const down = source.slice(source.indexOf('async down('));

		it('agrega solo las tres columnas (aditiva) y fija 80 en las filas de Chile ya sembradas', () => {
			expect(up).toContain('ALTER TABLE "contracts" ADD "invoice_description_template" jsonb');
			expect(up).toContain('ALTER TABLE "invoice_items" ADD "description_locked" boolean NOT NULL DEFAULT false');
			expect(up).toContain('ALTER TABLE "tax_document_types" ADD "description_max_chars" integer');
			expect(up).toContain(`UPDATE "tax_document_types" SET "description_max_chars" = 80 WHERE "country_code" = 'CL'`);
			expect(up.match(/ADD "/g)).toHaveLength(3);
			expect(up).not.toMatch(/DROP|TRIGGER|FUNCTION/);
		});

		it('el down quita las tres columnas en orden inverso', () => {
			expect(down.indexOf('DROP COLUMN "description_max_chars"')).toBeLessThan(down.indexOf('DROP COLUMN "description_locked"'));
			expect(down.indexOf('DROP COLUMN "description_locked"')).toBeLessThan(down.indexOf('DROP COLUMN "invoice_description_template"'));
		});

		it('la clase declara el mismo name que su nombre (lo exige schema-status)', () => {
			expect(source).toContain('export class InvoiceDescriptionTemplate1790670000000');
			expect(source).toContain(`name = 'InvoiceDescriptionTemplate1790670000000'`);
		});
	});
});
