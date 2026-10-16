#!/usr/bin/env node
/**
 * Bump de versión que corre GitHub Actions al mezclar un PR a `qa`
 * (`.github/workflows/version.yml`). Es el único lugar que escribe `version`
 * en package.json: si cada rama la subiera, el merge chocaría siempre.
 *
 * Lee del entorno:
 * - PR_TITLE, PR_NUMBER: arman el mensaje del commit.
 * - PR_LABELS: separados por coma; `version:minor` / `version:major` cambian el tipo de bump.
 * - GITHUB_OUTPUT: si existe, deja `version` y `message` para los pasos siguientes.
 *
 * Mismo script que front-sapira/scripts/ci/version-bump.mjs, en CommonJS para Jest.
 */

// CommonJS a propósito: corre con `node` en Actions sin compilar y Jest lo importa directo.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('node:fs');

const LABEL_MINOR = 'version:minor';
const LABEL_MAJOR = 'version:major';

function bumpTypeFromLabels(labels) {
	const names = String(labels ?? '')
		.split(',')
		.map((label) => label.trim());

	if (names.includes(LABEL_MAJOR)) return 'major';
	if (names.includes(LABEL_MINOR)) return 'minor';

	return 'patch';
}

function bumpVersion(currentVersion, bumpType) {
	const parts = String(currentVersion)
		.split('.')
		.map((value) => (/^\d+$/.test(value) ? Number(value) : Number.NaN));

	if (parts.length !== 3 || parts.some(Number.isNaN)) {
		throw new Error(`Versión inválida en package.json: ${currentVersion}`);
	}

	const [major, minor, patch] = parts;

	if (bumpType === 'major') return `${major + 1}.0.0`;
	if (bumpType === 'minor') return `${major}.${minor + 1}.0`;

	return `${major}.${minor}.${patch + 1}`;
}

/**
 * Cambia solo el valor de `version`, sin re-serializar el JSON: así se conservan
 * los tabs, el orden y cualquier formato del archivo.
 */
function applyVersion(source, nextVersion) {
	const pattern = /("version"\s*:\s*")[^"]*(")/;

	if (!pattern.test(source)) {
		throw new Error('package.json no contiene un campo version.');
	}

	return source.replace(pattern, `$1${nextVersion}$2`);
}

/** `v0.0.132 - Título del PR (#222)`. El título va en una sola línea. */
function buildCommitMessage(version, title, number) {
	const cleanTitle = String(title ?? '')
		.replace(/\s+/g, ' ')
		.trim();
	const suffix = number ? ` (#${number})` : '';

	return cleanTitle ? `v${version} - ${cleanTitle}${suffix}` : `v${version}${suffix}`;
}

function main(env, packagePath = 'package.json') {
	const source = fs.readFileSync(packagePath, 'utf8');
	const currentVersion = JSON.parse(source).version;
	const version = bumpVersion(currentVersion, bumpTypeFromLabels(env.PR_LABELS ?? ''));
	const message = buildCommitMessage(version, env.PR_TITLE, env.PR_NUMBER);

	fs.writeFileSync(packagePath, applyVersion(source, version));

	if (env.GITHUB_OUTPUT) {
		// Formato multilínea de GITHUB_OUTPUT: el título del PR no puede romperlo.
		fs.appendFileSync(env.GITHUB_OUTPUT, `version=${version}\nmessage<<__VERSION_EOF__\n${message}\n__VERSION_EOF__\n`);
	}

	process.stdout.write(`${currentVersion} → ${version}: ${message}\n`);

	return { version, message };
}

module.exports = { LABEL_MINOR, LABEL_MAJOR, bumpTypeFromLabels, bumpVersion, applyVersion, buildCommitMessage, main };

if (require.main === module) {
	main(process.env);
}
