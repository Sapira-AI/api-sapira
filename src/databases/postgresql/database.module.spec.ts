import * as fs from 'fs';
import * as path from 'path';

/**
 * Guard rojo del carril B (rediseño v2): ninguna configuración de TypeORM del repo puede alterar la base de datos,
 * y el espejo de entities (`entities/<modulo>/`) no se carga en runtime hasta el paso 3 (validado con Leon).
 */
describe('Guard: TypeORM nunca sincroniza esquema y el espejo es inerte', () => {
	const srcDir = path.join(__dirname, '..', '..');
	const entitiesDir = path.join(__dirname, 'entities');

	const listTypeScriptFiles = (dir: string): string[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
			return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [fullPath] : [];
		});

	it('database.module.ts mantiene synchronize: false', () => {
		const source = fs.readFileSync(path.join(__dirname, 'database.module.ts'), 'utf8');
		expect(source).toMatch(/synchronize:\s*false/);
		expect(source).not.toMatch(/synchronize:\s*true/);
	});

	it('ningún archivo de src habilita synchronize, dropSchema ni migrationsRun', () => {
		const offenders = listTypeScriptFiles(srcDir).filter((file) =>
			/\b(synchronize|dropSchema|migrationsRun)\s*:\s*true\b/.test(fs.readFileSync(file, 'utf8'))
		);
		expect(offenders).toEqual([]);
	});

	it('el espejo es inerte: ningún archivo dentro de entities/<modulo>/ termina en .entity.ts (glob de database.module.ts)', () => {
		const offenders = fs
			.readdirSync(entitiesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((dir) => listTypeScriptFiles(path.join(entitiesDir, dir.name)))
			.filter((file) => file.endsWith('.entity.ts'));
		expect(offenders).toEqual([]);
	});
});
