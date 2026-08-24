import * as path from 'path';

import 'reflect-metadata';
import { DataSource } from 'typeorm';

/**
 * Extrae la metadata TypeORM de las entities EXISTENTES del repo (las mismas que carga el API en producción por el glob
 * `src/** /*.entity.ts` de database.module.ts) para un conjunto de tablas, SIN conectarse a ninguna base.
 * Sirve para comparar cada entity existente con el estado real de prod (scripts/espejo/generate-espejo.py).
 *
 * Uso:
 *   npx ts-node -r tsconfig-paths/register scripts/espejo/extract-existing-metadata.ts users companies > scripts/espejo/snapshots/<modulo>.existing.json
 */
async function main() {
	const tables = process.argv.slice(2);
	const dataSource = new DataSource({ type: 'postgres', entities: [path.join(__dirname, '..', '..', 'src', '**', '*.entity.{ts,js}')] });
	await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();

	const out: Record<string, unknown> = {};
	for (const metadata of dataSource.entityMetadatas) {
		if (tables.length && !tables.includes(metadata.tableName)) continue;
		const target = metadata.target as { name?: string };
		out[metadata.tableName] = {
			class: typeof target === 'function' ? target.name : String(target),
			columns: Object.fromEntries(
				metadata.columns.map((column) => [
					column.databaseName,
					{
						type: typeof column.type === 'string' ? column.type : (column.type as { name: string }).name,
						nullable: column.isNullable,
						primary: column.isPrimary,
						generated: column.generationStrategy ?? null,
						default: typeof column.default === 'function' ? column.default() : (column.default ?? null),
						length: column.length || null,
						precision: column.precision ?? null,
						scale: column.scale ?? null,
						array: column.isArray,
					},
				])
			),
			uniques: Object.fromEntries(metadata.uniques.map((unique) => [unique.name, unique.columns.map((column) => column.databaseName)])),
			indices: Object.fromEntries(
				metadata.indices.map((index) => [
					index.name,
					{ columns: index.columns.map((column) => column.databaseName), unique: index.isUnique, where: index.where ?? null },
				])
			),
			checks: metadata.checks.map((check) => ({ name: check.name, expression: check.expression })),
			foreignKeys: Object.fromEntries(
				metadata.foreignKeys.map((fk) => [
					fk.name,
					{ columns: fk.columnNames, table: fk.referencedEntityMetadata.tableName, onDelete: fk.onDelete },
				])
			),
		};
	}
	process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
