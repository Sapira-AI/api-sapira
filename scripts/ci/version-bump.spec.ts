import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyVersion, buildCommitMessage, bumpTypeFromLabels, bumpVersion, main } from './version-bump';

describe('bumpTypeFromLabels', () => {
	it('sube patch si el PR no trae etiqueta de versión', () => {
		expect(bumpTypeFromLabels('')).toBe('patch');
		expect(bumpTypeFromLabels('bug,backend')).toBe('patch');
	});

	it('respeta version:minor y version:major, con major por sobre minor', () => {
		expect(bumpTypeFromLabels('backend, version:minor')).toBe('minor');
		expect(bumpTypeFromLabels('version:minor,version:major')).toBe('major');
	});
});

describe('bumpVersion', () => {
	it('sube patch, minor y major', () => {
		expect(bumpVersion('0.0.131', 'patch')).toBe('0.0.132');
		expect(bumpVersion('0.0.131', 'minor')).toBe('0.1.0');
		expect(bumpVersion('0.0.131', 'major')).toBe('1.0.0');
	});

	it('rechaza versiones que no son X.Y.Z', () => {
		expect(() => bumpVersion('0.1', 'patch')).toThrow('Versión inválida');
		expect(() => bumpVersion('0.1.7-beta', 'patch')).toThrow('Versión inválida');
		expect(() => bumpVersion(undefined, 'patch')).toThrow('Versión inválida');
	});
});

describe('applyVersion', () => {
	it('cambia solo la versión y conserva el formato con tabs', () => {
		const source = '{\n\t"name": "api-sapira",\n\t"version": "0.0.131",\n\t"private": true\n}\n';

		expect(applyVersion(source, '0.0.132')).toBe('{\n\t"name": "api-sapira",\n\t"version": "0.0.132",\n\t"private": true\n}\n');
	});

	it('falla si no hay campo version', () => {
		expect(() => applyVersion('{\n\t"name": "x"\n}\n', '1.0.0')).toThrow('no contiene un campo version');
	});
});

describe('buildCommitMessage', () => {
	it('arma vX.Y.Z - título (#PR)', () => {
		expect(buildCommitMessage('0.0.132', 'Tasa fija en modificaciones', 222)).toBe('v0.0.132 - Tasa fija en modificaciones (#222)');
	});

	it('deja el título en una línea y tolera que falte', () => {
		expect(buildCommitMessage('0.0.132', '  Línea uno\nlínea dos  ', '223')).toBe('v0.0.132 - Línea uno línea dos (#223)');
		expect(buildCommitMessage('0.0.132', '', '')).toBe('v0.0.132');
	});
});

describe('main', () => {
	let dir: string | undefined;

	afterEach(() => {
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	});

	it('escribe package.json y deja version y message en GITHUB_OUTPUT', () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'version-bump-'));
		const packagePath = path.join(dir, 'package.json');
		const outputPath = path.join(dir, 'output');

		fs.writeFileSync(packagePath, '{\n\t"name": "api-sapira",\n\t"version": "0.0.131"\n}\n');

		const result = main({ PR_TITLE: 'Nuevo endpoint', PR_NUMBER: '224', PR_LABELS: 'version:minor', GITHUB_OUTPUT: outputPath }, packagePath);

		expect(result).toEqual({ version: '0.1.0', message: 'v0.1.0 - Nuevo endpoint (#224)' });
		expect(JSON.parse(fs.readFileSync(packagePath, 'utf8')).version).toBe('0.1.0');
		expect(fs.readFileSync(outputPath, 'utf8')).toBe(
			'version=0.1.0\nmessage<<__VERSION_EOF__\nv0.1.0 - Nuevo endpoint (#224)\n__VERSION_EOF__\n'
		);
	});
});
