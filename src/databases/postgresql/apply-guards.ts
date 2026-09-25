/**
 * Guardas del CLI de assets: lo que documentación sola no puede impedir.
 *
 * Las dos reglas que estaban escritas en `CLAUDE.md` y se rompieron igual:
 *
 *  1. **`--apply` siempre con `--only`.** Un apply sin filtro aplica todo lo que no esté en el
 *     historial. En septiembre de 2026 eso eran 23 assets huérfanos, y 13 de ellos se aplicaban sin
 *     error reactivando comportamiento que se había eliminado a propósito.
 *  2. **Solo se aplica contenido commiteado.** El 2026-09-21 se aplicaron dos funciones desde una
 *     copia de trabajo: el historial quedó con un checksum que no existía en ninguna rama, así que
 *     el repo describía una cosa y la base otra, y el runner ofrecía "re-aplicar" para revertir el
 *     arreglo vivo.
 *
 * Todo acá es puro: recibe el texto de `git status --porcelain -z` y devuelve o lanza. El I/O
 * (ejecutar git) queda en el CLI, que es quien puede fallar por falta de git.
 */
import * as path from 'path';

import { AssetMode, SqlAsset } from './assets-runner';

export interface FiltroOptions {
	mode: AssetMode;
	only?: string[];
	all?: boolean;
}

/**
 * Exige un filtro explícito en `apply`: o `--only <ruta>` por asset, o `--all` a conciencia.
 *
 * `baseline` no lo necesita: registra sin ejecutar y solo lo verificado idéntico a la base.
 */
export function assertFiltroExplicito(options: FiltroOptions): void {
	if (options.mode !== 'apply') return;
	if (options.all || (options.only && options.only.length > 0)) return;

	throw new Error(
		'--apply exige --only <ruta> por cada asset que tocaste (o --all, a conciencia). ' +
			'Sin filtro se aplica todo lo que no esté registrado en el historial. ' +
			'Ver GUIA-CAMBIOS-DE-ESQUEMA.md → Sincronizar cambios a QA y producción.'
	);
}

/**
 * Rutas con cambios sin commitear, leídas de `git status --porcelain -z --untracked-files=all`.
 *
 * `-z` y no el formato por líneas: con el formato normal git escapa y entrecomilla las rutas con
 * espacios o acentos, y el corpus tiene 130 archivos de `rls/` con espacios en el nombre
 * (`rls/Users can view ….sql`), justo los que quedarían fuera de la comparación.
 *
 * En un renombrado o copia (`R`/`C`) el registro trae destino y origen como dos entradas: se
 * devuelven las dos, porque tanto el archivo nuevo como el que desapareció son cambios sin commitear.
 */
export function rutasModificadas(porcelain: string): string[] {
	const registros = porcelain.split('\0').filter((registro) => registro !== '');
	const rutas: string[] = [];

	for (let index = 0; index < registros.length; index += 1) {
		const registro = registros[index];
		// `XY ruta`: dos caracteres de estado, un espacio, y la ruta.
		const estado = registro.slice(0, 2);
		rutas.push(registro.slice(3));
		if (estado.includes('R') || estado.includes('C')) {
			const origen = registros[++index];
			if (origen !== undefined) rutas.push(origen);
		}
	}

	return rutas;
}

/**
 * Aborta si alguno de los assets que se van a aplicar tiene cambios sin commitear.
 *
 * Se mira **solo la selección**, no todo el árbol: aplicar `--only rls/x.sql` mientras se edita otro
 * módulo es legítimo, y bloquearlo llevaría a que se use `--allow-dirty` por costumbre.
 *
 * @param modificadas rutas relativas a la raíz del repo (`rutasModificadas`)
 * @param assetsRootRelativo ruta del corpus relativa a la raíz del repo
 */
export function assertAssetsCommiteados(
	modificadas: readonly string[],
	assetsRootRelativo: string,
	assets: readonly SqlAsset[],
	allowDirty = false
): void {
	if (allowDirty) return;

	const sucias = new Set(modificadas.map((ruta) => toPosix(ruta)));
	const enConflicto = assets.map((asset) => toPosix(path.join(assetsRootRelativo, asset.path))).filter((ruta) => sucias.has(ruta));

	if (enConflicto.length === 0) return;

	throw new Error(
		`Estos assets tienen cambios sin commitear y no se pueden aplicar:\n  ${enConflicto.join('\n  ')}\n` +
			'Commitealos primero: el historial registra el checksum del archivo en disco, así que aplicar ' +
			'sin commitear deja un checksum que no existe en ninguna rama. Con --allow-dirty se omite esta guarda.'
	);
}

function toPosix(ruta: string): string {
	return ruta.split(path.sep).join('/');
}
