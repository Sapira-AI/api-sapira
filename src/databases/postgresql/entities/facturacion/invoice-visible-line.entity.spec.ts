import * as fs from 'fs';
import * as path from 'path';

import { DataSource, EntityMetadata } from 'typeorm';

import * as espejoExistentes from '../espejo.existing';
import * as espejoTodos from '../espejo.index';

import { InvoiceItem } from './invoice-item.entity';

/**
 * Facturas en el Contrato 360 · etapa 6 (`docs/v2-rediseno/spec-facturas-en-contrato-360.md` §3.7b): la única columna nueva,
 * `invoice_items.visible_line_id`, nace por entity + migración `1790690000000-InvoiceVisibleLine`. Este spec fija lo que declara la entity y
 * lo que la migración escrita a mano crea, sin conectarse a ninguna base. `is_visible` sigue siendo derivado (no hay columna).
 */
describe('Línea visible ↔ internas (entity + migración 1790690000000)', () => {
	const dataSource = new DataSource({ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] });
	let metadata: EntityMetadata;

	beforeAll(async () => {
		await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
		metadata = dataSource.entityMetadatas.find((entry) => entry.target === InvoiceItem)!;
	});

	it('declara visible_line_id (uuid NULL) con FK a invoice_items ON DELETE SET NULL, índice parcial y comentario', () => {
		expect(dataSource.isInitialized).toBe(false);
		const column = metadata.columns.find((entry) => entry.databaseName === 'visible_line_id');

		expect(column).toMatchObject({ type: 'uuid', isNullable: true });
		expect(column?.comment).toBe('línea interna ligada a la línea visible del documento; NULL = línea normal');
		const fk = metadata.foreignKeys.find((entry) => entry.name === 'invoice_items_visible_line_id_fkey');

		expect(fk?.referencedEntityMetadata.tableName).toBe('invoice_items');
		expect(fk?.onDelete).toBe('SET NULL');
		expect(fk?.columns.map((entry) => entry.databaseName)).toEqual(['visible_line_id']);
		const index = metadata.indices.find((entry) => entry.name === 'idx_invoice_items_visible_line_id');

		expect(index?.columns.map((entry) => entry.databaseName)).toEqual(['visible_line_id']);
		expect(index?.where).toBe('visible_line_id IS NOT NULL');
	});

	it('no crea is_visible (derivado: quantity <> 0 AND visible_line_id IS NULL)', () => {
		expect(metadata.columns.map((entry) => entry.databaseName)).not.toContain('is_visible');
	});

	describe('migración', () => {
		const source = fs.readFileSync(path.join(__dirname, '..', '..', 'migrations', '1790690000000-InvoiceVisibleLine.ts'), 'utf8');
		const up = source.slice(source.indexOf('async up('), source.indexOf('async down('));
		const down = source.slice(source.indexOf('async down('));

		it('el up agrega solo la columna, su FK, el índice y el comentario: sin tablas, triggers, funciones ni datos', () => {
			expect(up).toContain('ALTER TABLE "invoice_items" ADD "visible_line_id" uuid');
			expect(up).toContain(
				'ADD CONSTRAINT "invoice_items_visible_line_id_fkey" FOREIGN KEY ("visible_line_id") REFERENCES "invoice_items"("id") ON DELETE SET NULL'
			);
			expect(up).toContain(
				'CREATE INDEX "idx_invoice_items_visible_line_id" ON "invoice_items" ("visible_line_id") WHERE visible_line_id IS NOT NULL'
			);
			expect(up).toContain(
				`COMMENT ON COLUMN "invoice_items"."visible_line_id" IS 'línea interna ligada a la línea visible del documento; NULL = línea normal'`
			);
			expect(up.match(/ADD "/g)).toHaveLength(1);
			expect(up).not.toMatch(/DROP|CREATE TABLE|TRIGGER|FUNCTION|UPDATE "|DELETE FROM|is_visible/);
		});

		it('el down quita índice, FK y columna en orden inverso', () => {
			expect(down.indexOf('DROP INDEX "public"."idx_invoice_items_visible_line_id"')).toBeGreaterThan(-1);
			expect(down.indexOf('DROP INDEX')).toBeLessThan(down.indexOf('DROP CONSTRAINT "invoice_items_visible_line_id_fkey"'));
			expect(down.indexOf('DROP CONSTRAINT')).toBeLessThan(down.indexOf('DROP COLUMN "visible_line_id"'));
		});

		it('la clase declara el mismo name que su nombre (lo exige schema-status)', () => {
			expect(source).toContain('export class InvoiceVisibleLine1790690000000');
			expect(source).toContain(`name = 'InvoiceVisibleLine1790690000000'`);
		});
	});
});
