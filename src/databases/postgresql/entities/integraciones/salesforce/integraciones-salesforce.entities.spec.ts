import * as fs from 'fs';
import * as path from 'path';

import { DataSource, EntityMetadata } from 'typeorm';

import * as espejoExistentes from '../../espejo.existing';
import * as espejoTodos from '../../espejo.index';

import { INTEGRACIONES_SALESFORCE_PROD_SNAPSHOT } from './integraciones-salesforce.prod-snapshot';

import * as modulo from './index';

/**
 * Verifica que los espejos del módulo `integraciones/salesforce` coinciden con el snapshot de prod (columnas + nullabilidad, PK,
 * FKs con ON DELETE, UNIQUE, CHECK e índices) y que no duplican tablas que ya tienen entity en el repo.
 * Construye la metadata en memoria con TODOS los espejos + todas las entities existentes (destinos de FK): NO abre conexión.
 */
describe('Espejo integraciones/salesforce (TypeORM ↔ prod public)', () => {
	const mirrorEntities = Object.values(modulo);
	const dataSource = new DataSource({ type: 'postgres', entities: [...Object.values(espejoTodos), ...Object.values(espejoExistentes)] });
	const existingEntities: Record<string, { class: string; file: string }> = JSON.parse(
		fs.readFileSync(path.join(__dirname, '..', '..', '..', '..', '..', '..', 'scripts', 'espejo', 'existing-entities.json'), 'utf8')
	);
	let mirrorMetadatas: EntityMetadata[] = [];

	beforeAll(async () => {
		await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();
		const targets = new Set<unknown>(mirrorEntities);
		mirrorMetadatas = dataSource.entityMetadatas.filter((metadata) => targets.has(metadata.target));
	});

	it('construye la metadata sin conectarse ni sincronizar esquema (guard rojo)', () => {
		expect(dataSource.isInitialized).toBe(false);
		expect(dataSource.options.synchronize).toBeFalsy();
		expect(mirrorMetadatas.length).toBeGreaterThan(0);
	});

	it('mapea exactamente las tablas del snapshot (las que no tenían entity en el repo)', () => {
		expect(mirrorMetadatas.map((m) => m.tableName).sort()).toEqual(Object.keys(INTEGRACIONES_SALESFORCE_PROD_SNAPSHOT).sort());
	});

	it('no duplica ninguna tabla que ya tiene entity existente en el repo', () => {
		expect(mirrorMetadatas.map((m) => m.tableName).filter((table) => table in existingEntities)).toEqual([]);
	});

	describe.each(Object.entries(INTEGRACIONES_SALESFORCE_PROD_SNAPSHOT))('%s', (table, expected) => {
		const metadata = () => mirrorMetadatas.find((m) => m.tableName === table);

		it('tiene las mismas columnas y nullabilidad que prod', () => {
			expect(Object.fromEntries(metadata().columns.map((column) => [column.databaseName, column.isNullable]))).toEqual(expected.columns);
		});

		it('tiene la misma clave primaria que prod', () => {
			expect(
				metadata()
					.primaryColumns.map((column) => column.databaseName)
					.sort()
			).toEqual([...expected.primary].sort());
		});

		it('tiene las mismas FKs (nombre → tabla, ON DELETE) que prod', () => {
			expect(
				Object.fromEntries(
					metadata().foreignKeys.map((fk) => [fk.name, { table: fk.referencedEntityMetadata.tableName, onDelete: fk.onDelete }])
				)
			).toEqual(expected.foreignKeys);
		});

		it('tiene los mismos UNIQUE (nombre → columnas) que prod', () => {
			expect(
				Object.fromEntries(metadata().uniques.map((unique) => [unique.name, unique.columns.map((column) => column.databaseName)]))
			).toEqual(expected.uniques);
		});

		it('tiene los mismos CHECK (nombres) que prod', () => {
			expect(
				metadata()
					.checks.map((check) => check.name)
					.sort()
			).toEqual([...expected.checks].sort());
		});

		it('tiene los mismos índices declarables (nombre → columnas, unique, where) que prod', () => {
			expect(
				Object.fromEntries(
					metadata().indices.map((index) => [
						index.name,
						{ columns: index.columns.map((column) => column.databaseName), unique: index.isUnique, where: index.where ?? null },
					])
				)
			).toEqual(expected.indexes);
		});
	});
});
