import * as fs from 'fs';
import * as path from 'path';

/**
 * Guard del carril B: los espejos permanecen inertes hasta su promoción y
 * synchronize solo se permite mediante la configuración explícita centralizada.
 */
describe('Guard: entidades espejo y configuración TypeORM', () => {
	const srcDir = path.join(__dirname, '..', '..');
	const entitiesDir = path.join(__dirname, 'entities');
	const promotedMirrorEntities = new Set([path.join(entitiesDir, 'base-tenancy', 'permission.entity.ts')]);

	const listTypeScriptFiles = (dir: string): string[] =>
		fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
			const fullPath = path.join(dir, entry.name);
			if (entry.isDirectory()) return listTypeScriptFiles(fullPath);
			return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [fullPath] : [];
		});

	it('database.module.ts delega la sincronización a la configuración protegida', () => {
		const source = fs.readFileSync(path.join(__dirname, 'database.module.ts'), 'utf8');
		expect(source).toContain('createPostgreSqlOptions');
	});

	it('ningún archivo de src habilita synchronize, dropSchema ni migrationsRun de forma literal', () => {
		const offenders = listTypeScriptFiles(srcDir).filter((file) =>
			/\b(synchronize|dropSchema|migrationsRun)\s*:\s*true\b/.test(fs.readFileSync(file, 'utf8'))
		);
		expect(offenders).toEqual([]);
	});

	it('solo carga en runtime los espejos promovidos explícitamente', () => {
		const offenders = fs
			.readdirSync(entitiesDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.flatMap((dir) => listTypeScriptFiles(path.join(entitiesDir, dir.name)))
			.filter((file) => file.endsWith('.entity.ts') && !promotedMirrorEntities.has(file));
		expect(offenders).toEqual([]);
	});
});
