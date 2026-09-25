import * as fs from 'fs';
import * as path from 'path';

/**
 * Guarda: todo índice de producción tiene que estar declarado en alguna parte.
 *
 * TypeORM dropea cualquier índice que exista en la base y no encuentre en la entity. Mientras
 * un índice no esté declarado como `@Index(...)` ni exista como asset en `special-index/`,
 * `migration:generate` emite un `DROP INDEX` sobre él y nada lo detiene: la revisión manual de
 * la migración es la única barrera, y 161 índices reales de producción pasaron por ese hueco.
 *
 * La regla de corte es la del módulo: si TypeORM lo puede declarar (btree sobre columnas
 * simples, con o sin `WHERE`), lo declara la entity; si no (gin, ivfflat, orden explícito,
 * expresiones), es un asset de `special-index/`.
 */

const RAIZ = path.resolve(__dirname, '..', '..', '..', '..');
const CATALOGO = path.join(RAIZ, 'scripts', 'espejo', 'snapshots', 'raw', 'catalog.json');
const SPECIAL_INDEX = path.join(RAIZ, 'src', 'databases', 'postgresql', 'special-index');

interface IndiceCatalogo {
	name: string;
	def: string;
	unique: boolean;
	primary: boolean;
}

interface TablaCatalogo {
	indexes?: IndiceCatalogo[];
	constraints?: { name: string; def: string }[];
}

/** `CREATE [UNIQUE] INDEX <nombre> ON public.<tabla> USING <método> (<columnas>) [WHERE ...]` */
const DEFINICION = /^CREATE (UNIQUE )?INDEX (\S+) ON public\.(\S+) USING (\w+) \((.*?)\)(?: WHERE (.*))?$/;
const COLUMNA_SIMPLE = /^[a-z_0-9]+$/;

/** Un índice es declarable con `@Index` si es btree sobre columnas simples, sin orden explícito. */
function esDeclarable(definicion: string): boolean {
	const partes = DEFINICION.exec(definicion);
	if (!partes) return false;
	const [, , , , metodo, columnas] = partes;
	if (metodo !== 'btree') return false;
	return columnas.split(',').every((columna) => COLUMNA_SIMPLE.test(columna.trim()));
}

function leerArchivosDeEntities(): string[] {
	const archivos: string[] = [];
	const recorrer = (directorio: string): void => {
		for (const entrada of fs.readdirSync(directorio, { withFileTypes: true })) {
			const ruta = path.join(directorio, entrada.name);
			if (entrada.isDirectory()) recorrer(ruta);
			else if (entrada.name.endsWith('.entity.ts') || entrada.name.endsWith('.espejo.ts')) archivos.push(ruta);
		}
	};
	recorrer(path.join(RAIZ, 'src'));
	return archivos;
}

describe('índices de producción declarados', () => {
	const catalogo = JSON.parse(fs.readFileSync(CATALOGO, 'utf8')) as { tables: Record<string, TablaCatalogo> };

	// Dos cosas distintas que se escriben igual:
	//   @Index('x', ['col'])                    → la entity DECLARA el índice y TypeORM lo gestiona.
	//   @Index('x', { synchronize: false })     → la entity solo AVISA que existe y que no lo toque.
	// La segunda forma es la que evita que `migration:generate` emita un DROP INDEX sobre los 41
	// assets de `special-index/`, que TypeORM no puede declarar y por eso no reconoce.
	const declaradosEnEntities = new Set<string>();
	const marcadosComoExternos = new Set<string>();
	for (const archivo of leerArchivosDeEntities()) {
		const contenido = fs.readFileSync(archivo, 'utf8');
		for (const coincidencia of contenido.matchAll(/@Index\('([^']+)'\s*,\s*([^)]*)\)/g)) {
			if (/synchronize:\s*false/.test(coincidencia[2])) marcadosComoExternos.add(coincidencia[1]);
			else declaradosEnEntities.add(coincidencia[1]);
		}
	}

	const enSpecialIndex = new Set(
		fs
			.readdirSync(SPECIAL_INDEX)
			.filter((archivo) => archivo.endsWith('.sql'))
			.map((archivo) => archivo.slice(0, -'.sql'.length))
	);

	/**
	 * Postgres crea un índice implícito por cada PK y cada UNIQUE, con el nombre del constraint.
	 * Esos no se declaran con `@Index` sino con `@PrimaryGeneratedColumn` / `@Unique`, así que
	 * quedan fuera de la guarda: TypeORM los reconoce por el constraint y no los dropea.
	 */
	const respaldaConstraint = (tabla: TablaCatalogo, nombre: string): boolean =>
		(tabla.constraints ?? []).some((constraint) => constraint.name === nombre);

	it('declara en la entity todo índice btree simple de producción', () => {
		const sinDeclarar: string[] = [];
		for (const [tabla, definicionTabla] of Object.entries(catalogo.tables)) {
			for (const indice of definicionTabla.indexes ?? []) {
				if (indice.primary || respaldaConstraint(definicionTabla, indice.name)) continue;
				if (!esDeclarable(indice.def)) continue;
				if (declaradosEnEntities.has(indice.name) || enSpecialIndex.has(indice.name)) continue;
				sinDeclarar.push(`${tabla}.${indice.name}`);
			}
		}
		expect(sinDeclarar).toEqual([]);
	});

	it('deja en special-index/ los índices que TypeORM no puede declarar', () => {
		const sinAsset: string[] = [];
		for (const [tabla, definicionTabla] of Object.entries(catalogo.tables)) {
			for (const indice of definicionTabla.indexes ?? []) {
				if (indice.primary || respaldaConstraint(definicionTabla, indice.name)) continue;
				if (esDeclarable(indice.def)) continue;
				if (enSpecialIndex.has(indice.name) || declaradosEnEntities.has(indice.name)) continue;
				sinAsset.push(`${tabla}.${indice.name}`);
			}
		}
		expect(sinAsset).toEqual([]);
	});

	it('no deja assets en special-index/ para índices que la entity ya declara', () => {
		const duplicados = [...enSpecialIndex].filter((nombre) => declaradosEnEntities.has(nombre));
		expect(duplicados).toEqual([]);
	});

	it('marca en la entity, con synchronize: false, cada índice de special-index/', () => {
		// Sin esta marca TypeORM no sabe que el índice existe y `migration:generate` emite un
		// `DROP INDEX` por cada uno: eran 41 de las 94 sentencias de ruido que había que borrar a
		// mano en cada migración, y el riesgo es que en esa limpieza se cuele un DROP real.
		const tablaDeIndice = new Map<string, string>();
		for (const [tabla, definicionTabla] of Object.entries(catalogo.tables)) {
			for (const indice of definicionTabla.indexes ?? []) tablaDeIndice.set(indice.name, tabla);
		}

		const sinMarcar = [...enSpecialIndex]
			.filter((nombre) => tablaDeIndice.has(nombre)) // el que ya no existe en prod es otra deuda
			.filter((nombre) => !marcadosComoExternos.has(nombre))
			.map((nombre) => `${tablaDeIndice.get(nombre)}.${nombre}`);

		expect(sinMarcar).toEqual([]);
	});
});
