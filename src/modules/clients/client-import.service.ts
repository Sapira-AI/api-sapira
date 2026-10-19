import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { resolveCountryInput } from '@/core/utils/country-resolve';
import type { ImportBatchRowStatus } from '@/databases/postgresql/entities/clientes/import-batch-row.entity';
import { withApiWriter } from '@/modules/contracts/api-writer';

import {
	type ClientImportApplyDto,
	type ClientImportField,
	type ClientImportKey,
	type ClientImportPreviewDto,
	type ClientImportRowDto,
} from './dtos/client-import.dto';

type Row = Record<string, unknown>;
type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };
type FieldValues = Partial<Record<ClientImportField, string | null>>;

/** Lo que se lee de cada cliente para comparar: los campos importables más `country_code` (viaja junto con `country`). */
const CLIENT_COLUMNS = `c.id, c.name_commercial, c.segment, c.industry, c.market, c.country, c.country_code, to_char(c.client_since, 'YYYY-MM-DD') AS client_since, c.notes`;

/** Listas del holding que validan segmento, industria y mercado (las mismas que `ClientsService.prepareWrite`). */
const LISTS: Record<'segment' | 'industry' | 'market', { category: string; label: string }> = {
	market: { category: 'markets', label: 'El mercado' },
	segment: { category: 'segments', label: 'El segmento' },
	industry: { category: 'industries', label: 'La industria' },
};

export interface ClientImportChange {
	field: ClientImportField;
	from: string | null;
	to: string | null;
}

export interface ClientImportPlanRow {
	row: number;
	key: string;
	status: ImportBatchRowStatus;
	client: { id: string; name: string | null } | null;
	changes: ClientImportChange[];
	errors: string[];
	/** Valores a escribir (incluye `country_code` cuando cambia el país); solo con `status = 'updated'`. */
	after: Record<string, string | null>;
	before: Record<string, string | null>;
}

interface ClientRecord {
	id: string;
	name_commercial: string | null;
	segment: string | null;
	industry: string | null;
	market: string | null;
	country: string | null;
	country_code: string | null;
	client_since: string | null;
	notes: string | null;
}

export interface ImportActor {
	userId: string;
}

const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value).trim() || null);
const normKey = (value: string) => value.trim().toLowerCase();
/** RUT sin puntos ni guion, en minúscula (misma regla que `findEntityWithTaxId`). */
const normTaxId = (value: string) => value.replace(/[^0-9kK]/g, '').toLowerCase();
const conflict = (code: string, message: string) => new ConflictException({ code, message });

/**
 * "Importar para actualizar" clientes comerciales (Domi 19-10): la planilla exportada (o cualquiera con una columna clave) vuelve con las
 * columnas que la usuaria mapeó y solo esas se actualizan. Celda vacía = no cambia (el front no la manda). Cada importación queda en
 * `import_batches` + `import_batch_rows` con el antes y el después de cada campo, y se puede revertir: se restaura el valor anterior solo en
 * los campos cuyo valor actual sigue siendo el importado.
 */
@Injectable()
export class ClientImportService {
	constructor(private readonly dataSource: DataSource) {}

	/** Vista previa: qué haría la importación, fila a fila. No escribe. */
	async preview(holdingId: string, dto: ClientImportPreviewDto) {
		const rows = await this.plan(this.dataSource, holdingId, dto);

		return summarize(dto, rows);
	}

	/** Aplica la importación en una transacción y guarda el lote con el antes/después de cada fila actualizada. */
	async apply(holdingId: string, dto: ClientImportApplyDto, actor: ImportActor) {
		return await withApiWriter(this.dataSource, async (runner) => {
			const rows = await this.plan(runner, holdingId, dto);
			const summary = summarize(dto, rows);
			const [batch] = (await runner.query(
				`INSERT INTO import_batches (holding_id, entity_type, label, key_field, fields, rows_total, updated_count, skipped_count, failed_count, created_by)
				VALUES ($1, 'client', $2, $3, $4::jsonb, $5, $6, $7, $8, $9) RETURNING id, created_at`,
				[
					holdingId,
					dto.label || null,
					dto.key_field,
					JSON.stringify(dto.fields),
					rows.length,
					summary.counts.updated,
					summary.counts.unchanged + summary.counts.not_found + summary.counts.ambiguous,
					summary.counts.failed,
					actor.userId || null,
				]
			)) as Row[];
			const batchId = String(batch.id);

			for (const row of rows) {
				if (row.status === 'updated' && row.client) {
					const fields = Object.keys(row.after);

					await runner.query(
						`UPDATE clients SET ${fields.map((field, index) => `"${field}" = $${index + 3}`).join(', ')} WHERE id = $1 AND holding_id = $2`,
						[row.client.id, holdingId, ...fields.map((field) => row.after[field])]
					);
				}
				await runner.query(
					`INSERT INTO import_batch_rows (batch_id, holding_id, "row", key_value, entity_id, status, "before", "after", message)
					VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)`,
					[
						batchId,
						holdingId,
						row.row,
						row.key,
						row.client?.id ?? null,
						row.status,
						JSON.stringify(row.before),
						JSON.stringify(row.after),
						row.errors.join(' · ') || null,
					]
				);
			}

			return { batch_id: batchId, created_at: batch.created_at, ...summary };
		});
	}

	/** Últimos lotes del holding (los 20 más recientes), con quién los hizo y si están revertidos. */
	async batches(holdingId: string) {
		const rows = (await this.dataSource.query(
			`SELECT b.id, b.label, b.key_field, b.fields, b.rows_total, b.updated_count, b.skipped_count, b.failed_count, b.created_at, u.name AS created_by,
				b.reverted_at, r.name AS reverted_by, b.reverted_summary
			FROM import_batches b LEFT JOIN users u ON u.id = b.created_by LEFT JOIN users r ON r.id = b.reverted_by
			WHERE b.holding_id = $1 AND b.entity_type = 'client' ORDER BY b.created_at DESC LIMIT 20`,
			[holdingId]
		)) as Row[];

		return rows.map((row) => ({
			id: String(row.id),
			label: str(row.label),
			key_field: String(row.key_field),
			fields: (typeof row.fields === 'string' ? JSON.parse(row.fields) : row.fields) as string[],
			rows_total: Number(row.rows_total ?? 0),
			updated_count: Number(row.updated_count ?? 0),
			skipped_count: Number(row.skipped_count ?? 0),
			failed_count: Number(row.failed_count ?? 0),
			created_at: row.created_at,
			created_by: str(row.created_by),
			reverted_at: row.reverted_at ?? null,
			reverted_by: str(row.reverted_by),
			reverted_summary: (row.reverted_summary ?? null) as Record<string, unknown> | null,
		}));
	}

	/**
	 * Revierte un lote: en cada fila actualizada restaura el valor anterior de los campos cuyo valor actual sigue siendo el importado; los
	 * que alguien editó después quedan como están (`kept_fields`). 404 si no existe, 409 `already_reverted` si ya se revirtió.
	 */
	async revert(holdingId: string, batchId: string, actor: ImportActor) {
		return await withApiWriter(this.dataSource, async (runner) => {
			const [batch] = (await runner.query(
				`SELECT id, reverted_at FROM import_batches WHERE id = $1 AND holding_id = $2 AND entity_type = 'client' FOR UPDATE`,
				[batchId, holdingId]
			)) as Row[];

			if (!batch) throw new NotFoundException('Importación no encontrada');
			if (batch.reverted_at) throw conflict('already_reverted', 'La importación ya está revertida');
			const rows = (await runner.query(
				`SELECT r.id AS row_id, r.entity_id, r."before", r."after", ${CLIENT_COLUMNS}
				FROM import_batch_rows r LEFT JOIN clients c ON c.id = r.entity_id AND c.holding_id = r.holding_id
				WHERE r.batch_id = $1 AND r.holding_id = $2 AND r.status = 'updated' ORDER BY r."row"`,
				[batchId, holdingId]
			)) as Row[];
			let restoredRows = 0;
			let keptRows = 0;
			let keptFields = 0;

			for (const row of rows) {
				const before = parseJson(row.before);
				const after = parseJson(row.after);
				const restore: string[] = [];
				const kept: string[] = [];

				for (const field of Object.keys(after)) {
					if (!row.row_id || row.entity_id === null || !(field in row)) continue;
					if (str(row[field]) === str(after[field])) restore.push(field);
					else kept.push(field);
				}
				if (restore.length && row.entity_id) {
					await runner.query(
						`UPDATE clients SET ${restore.map((field, index) => `"${field}" = $${index + 3}`).join(', ')} WHERE id = $1 AND holding_id = $2`,
						[row.entity_id, holdingId, ...restore.map((field) => before[field] ?? null)]
					);
					restoredRows += 1;
				} else keptRows += 1;
				keptFields += kept.length;
				await runner.query(`UPDATE import_batch_rows SET reverted_fields = $2::jsonb, kept_fields = $3::jsonb WHERE id = $1`, [
					row.row_id,
					JSON.stringify(restore),
					JSON.stringify(kept),
				]);
			}
			const summary = { restored_rows: restoredRows, kept_rows: keptRows, kept_fields: keptFields };

			await runner.query(`UPDATE import_batches SET reverted_at = now(), reverted_by = $2, reverted_summary = $3::jsonb WHERE id = $1`, [
				batchId,
				actor.userId || null,
				JSON.stringify(summary),
			]);

			return { batch_id: batchId, ...summary };
		});
	}

	/** Plan fila a fila: busca el cliente por la clave, valida los valores mapeados y calcula los cambios. */
	private async plan(db: Queryable, holdingId: string, dto: ClientImportPreviewDto): Promise<ClientImportPlanRow[]> {
		const clientsByKey = await this.findClients(db, holdingId, dto.key_field, dto.rows);
		const lists = await this.loadLists(db, holdingId, dto.fields);
		const countries = await this.resolveCountries(db, dto.rows);
		const fields = new Set<ClientImportField>(dto.fields);

		return dto.rows.map((input): ClientImportPlanRow => {
			const key = dto.key_field === 'tax_id' ? normTaxId(input.key) : normKey(input.key);
			const matches = clientsByKey.get(key) ?? [];
			const base = { row: input.row, key: input.key, changes: [], after: {}, before: {} };

			if (matches.length === 0) return { ...base, status: 'not_found', client: null, errors: ['No hay un cliente con esa clave'] };
			if (matches.length > 1)
				return {
					...base,
					status: 'ambiguous',
					client: null,
					errors: [
						`${matches.length} clientes comparten la clave (${matches.map((client) => client.name_commercial ?? client.id).join(', ')})`,
					],
				};
			const client = matches[0];
			const errors: string[] = [];
			const changes: ClientImportChange[] = [];
			const after: Record<string, string | null> = {};
			const before: Record<string, string | null> = {};
			const values = input.fields as FieldValues;

			for (const field of Object.keys(values) as ClientImportField[]) {
				const raw = values[field];

				if (!fields.has(field) || raw === undefined || raw === null || raw === '') continue;
				if (field === 'country') {
					const resolved = countries.get(normKey(raw));

					if (!resolved) {
						errors.push(`País no reconocido: ${raw}`);
						continue;
					}
					if (resolved.country_code !== client.country_code || resolved.country !== client.country) {
						changes.push({ field, from: client.country, to: resolved.country });
						after.country = resolved.country;
						after.country_code = resolved.country_code;
						before.country = client.country;
						before.country_code = client.country_code;
					}
					continue;
				}
				const current = client[field];

				if (raw === current) continue;
				if (field in LISTS) {
					const list = LISTS[field as keyof typeof LISTS];

					if (!lists.get(list.category)?.has(raw)) {
						errors.push(`${list.label} "${raw}" no está en la lista del holding (Administración › Catálogos)`);
						continue;
					}
				}
				changes.push({ field, from: current, to: raw });
				after[field] = raw;
				before[field] = current;
			}
			const clientRef = { id: client.id, name: client.name_commercial };

			if (errors.length) return { ...base, status: 'failed', client: clientRef, changes, errors, after: {}, before: {} };
			if (!changes.length) return { ...base, status: 'unchanged', client: clientRef, errors: [] };

			return { ...base, status: 'updated', client: clientRef, changes, errors: [], after, before };
		});
	}

	/** Clientes del holding por clave normalizada (varios si la clave está repetida → fila ambigua). */
	private async findClients(
		db: Queryable,
		holdingId: string,
		keyField: ClientImportKey,
		rows: ClientImportRowDto[]
	): Promise<Map<string, ClientRecord[]>> {
		const norm = keyField === 'tax_id' ? normTaxId : normKey;
		const keys = [...new Set(rows.map((row) => norm(row.key)).filter(Boolean))];
		const found = (
			keys.length === 0
				? []
				: keyField === 'tax_id'
					? await db.query(
							`SELECT DISTINCT ${CLIENT_COLUMNS}, lower(regexp_replace(ce.tax_id, '[^0-9kK]', '', 'g')) AS key
							FROM client_entities ce
							LEFT JOIN client_entity_clients l ON l.client_entity_id = ce.id AND l.holding_id = ce.holding_id
							JOIN clients c ON c.id = COALESCE(l.client_id, ce.client_id) AND c.holding_id = ce.holding_id
							WHERE ce.holding_id = $1 AND lower(regexp_replace(ce.tax_id, '[^0-9kK]', '', 'g')) = ANY($2::text[])`,
							[holdingId, keys]
						)
					: await db.query(
							`SELECT ${CLIENT_COLUMNS}, lower(trim(c.client_number)) AS key FROM clients c WHERE c.holding_id = $1 AND lower(trim(c.client_number)) = ANY($2::text[])`,
							[holdingId, keys]
						)
		) as Row[];
		const byKey = new Map<string, ClientRecord[]>();

		for (const row of found) {
			const record: ClientRecord = {
				id: String(row.id),
				name_commercial: str(row.name_commercial),
				segment: str(row.segment),
				industry: str(row.industry),
				market: str(row.market),
				country: str(row.country),
				country_code: str(row.country_code),
				client_since: str(row.client_since),
				notes: str(row.notes),
			};
			const key = String(row.key);
			const list = byKey.get(key) ?? [];

			if (!list.some((client) => client.id === record.id)) list.push(record);
			byKey.set(key, list);
		}

		return byKey;
	}

	/** Valores activos de los catálogos del holding que la importación necesita (solo los campos mapeados). */
	private async loadLists(db: Queryable, holdingId: string, fields: ClientImportField[]): Promise<Map<string, Set<string>>> {
		const categories = fields.filter((field): field is keyof typeof LISTS => field in LISTS).map((field) => LISTS[field].category);
		const lists = new Map<string, Set<string>>();

		if (!categories.length) return lists;
		const rows = (await db.query(
			`SELECT category, value FROM master_data WHERE holding_id = $1 AND is_active = true AND category = ANY($2::text[])`,
			[holdingId, categories]
		)) as Row[];

		for (const row of rows) {
			const set = lists.get(String(row.category)) ?? new Set<string>();

			set.add(String(row.value));
			lists.set(String(row.category), set);
		}

		return lists;
	}

	/** País de cada fila resuelto una sola vez por valor distinto (nombre en español o inglés, alias o código ISO). */
	private async resolveCountries(
		db: Queryable,
		rows: ClientImportRowDto[]
	): Promise<Map<string, { country: string | null; country_code: string | null }>> {
		const values = [...new Set(rows.map((row) => row.fields.country).filter((value): value is string => Boolean(value)))];
		const resolved = new Map<string, { country: string | null; country_code: string | null }>();

		for (const value of values) {
			try {
				const input = /^[A-Za-z]{2}$/.test(value) ? { country_code: value } : { country: value };
				const country = await resolveCountryInput(db, input);

				if (country?.country_code) resolved.set(normKey(value), country);
			} catch {
				// País no reconocido: la fila lo reporta como error.
			}
		}

		return resolved;
	}
}

const parseJson = (value: unknown): Record<string, string | null> =>
	typeof value === 'string' ? JSON.parse(value) : ((value ?? {}) as Record<string, string | null>);

/** Resumen de un plan: conteos por estado y las filas sin los valores internos. */
function summarize(dto: ClientImportPreviewDto, rows: ClientImportPlanRow[]) {
	const count = (status: ImportBatchRowStatus) => rows.filter((row) => row.status === status).length;

	return {
		key_field: dto.key_field,
		fields: dto.fields,
		counts: {
			total: rows.length,
			updated: count('updated'),
			unchanged: count('unchanged'),
			not_found: count('not_found'),
			ambiguous: count('ambiguous'),
			failed: count('failed'),
		},
		rows: rows.map((row) => ({ row: row.row, key: row.key, status: row.status, client: row.client, changes: row.changes, errors: row.errors })),
	};
}
