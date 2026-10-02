/**
 * Base falsa para los specs de Configuración y Productos (no es un test: el nombre termina en `-spec.ts` para quedar fuera del build y
 * fuera de `testRegex`). Cada handler responde a las consultas cuyo SQL contiene el texto (o calza la regex); el primero gana. Lo que no
 * calza devuelve `[]`. Todas las sentencias quedan en `calls` para afirmar qué se escribió.
 */
export type Handler = [match: string | RegExp, respond: (params: unknown[]) => unknown[] | Promise<unknown[]>];

export interface FakeDb {
	query: jest.Mock;
	calls: { sql: string; params: unknown[] }[];
	createQueryRunner: () => {
		connect: jest.Mock;
		startTransaction: jest.Mock;
		commitTransaction: jest.Mock;
		rollbackTransaction: jest.Mock;
		release: jest.Mock;
		query: jest.Mock;
	};
	transaction: <T>(work: (manager: { query: jest.Mock; delete: jest.Mock; save: jest.Mock; create: jest.Mock }) => Promise<T>) => Promise<T>;
	/** Sentencias que contienen el texto. */
	statements: (text: string) => { sql: string; params: unknown[] }[];
	committed: () => number;
	rolledBack: () => number;
}

const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

export function fakeDb(handlers: Handler[] = []): FakeDb {
	const calls: { sql: string; params: unknown[] }[] = [];
	let commits = 0;
	let rollbacks = 0;
	const query = jest.fn(async (sql: string, params: unknown[] = []) => {
		const text = squash(sql);

		calls.push({ sql: text, params });
		for (const [match, respond] of handlers) {
			if (typeof match === 'string' ? text.includes(squash(match)) : match.test(text)) return respond(params);
		}

		return [];
	});

	return {
		query,
		calls,
		createQueryRunner: () => ({
			connect: jest.fn(),
			startTransaction: jest.fn(),
			commitTransaction: jest.fn(async () => {
				commits++;
			}),
			rollbackTransaction: jest.fn(async () => {
				rollbacks++;
			}),
			release: jest.fn(),
			query,
		}),
		transaction: async (work) => {
			try {
				const result = await work({ query, delete: jest.fn(), save: jest.fn(), create: jest.fn((_: unknown, value: unknown) => value) });

				commits++;

				return result;
			} catch (error) {
				rollbacks++;
				throw error;
			}
		},
		statements: (text: string) => calls.filter((call) => call.sql.includes(squash(text))),
		committed: () => commits,
		rolledBack: () => rollbacks,
	};
}
