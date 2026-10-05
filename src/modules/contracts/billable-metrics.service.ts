import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';

import { withApiWriter } from './api-writer';
import { resolveUserId } from './contract-drafts.service';

import type { CreateBillableMetricDto, UpdateBillableMetricDto } from './dtos/billable-metric.dto';

type Row = Record<string, unknown>;

const toText = (value: unknown) => (value === null || value === undefined ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : toText(value));

export const METRIC_CODE_TAKEN_MESSAGE = 'Ya existe una métrica con ese código en el holding';
export const METRIC_IN_USE_MESSAGE = 'La métrica tiene precios activos que la usan: archívalos o cámbialos antes';

/** Columnas que expone la API, con los agregados de uso. */
const METRIC_SELECT = `bm.id, bm.code, bm.name, bm.description, bm.aggregation, bm.unit, bm.source_kind, bm.source_config, bm.status,
	bm.created_at, bm.updated_at, bm.archived_at,
	(SELECT COUNT(*) FROM prices p WHERE p.billable_metric_id = bm.id AND p.status = 'active') AS prices_count,
	(SELECT COUNT(*) FROM prices p WHERE p.billable_metric_id = bm.id) AS prices_total,
	(SELECT MAX(e.created_at) FROM consumption_entries e
		JOIN contract_items ci ON ci.id = e.contract_item_id
		JOIN prices p ON p.id = ci.price_id
		WHERE p.billable_metric_id = bm.id AND e.source IN ('dwh', 'api')) AS last_sync_at`;

/**
 * Métricas facturables por holding (Pricing v2 §2.1 y §5): CRUD y archivo. Etapa 1 y 2: `source_kind` se guarda tal cual
 * pero solo `manual` (y `csv`, que carga la usuaria) es funcional; `dwh`/`api` llegan con el canal DWH. `last_sync_at` es la
 * última entry `dwh`/`api` de un ítem que use la métrica (no hay columna propia en la spec).
 */
@Injectable()
export class BillableMetricsService {
	constructor(private readonly dataSource: DataSource) {}

	static toView(row: Row) {
		return {
			id: String(row.id),
			code: String(row.code),
			name: String(row.name),
			description: toText(row.description),
			aggregation: String(row.aggregation),
			unit: String(row.unit),
			source_kind: String(row.source_kind ?? 'manual'),
			source_config: (typeof row.source_config === 'string' ? JSON.parse(row.source_config) : row.source_config) ?? {},
			status: String(row.status ?? 'active'),
			prices_count: toNumber(row.prices_count),
			prices_total: toNumber(row.prices_total),
			last_sync_at: iso(row.last_sync_at),
			created_at: iso(row.created_at),
			updated_at: iso(row.updated_at),
			archived_at: iso(row.archived_at),
		};
	}

	/** `GET /billable-metrics`: todas las del holding (activas primero), con `prices_count` y `last_sync_at`. */
	async list(holdingId: string, options: { includeArchived?: boolean } = {}) {
		const rows = (await this.dataSource.query(
			`SELECT ${METRIC_SELECT} FROM billable_metrics bm
			WHERE bm.holding_id = $1 ${options.includeArchived ? '' : `AND bm.status = 'active'`}
			ORDER BY bm.status, bm.name`,
			[holdingId]
		)) as Row[];

		return { data: rows.map(BillableMetricsService.toView) };
	}

	/** `GET /billable-metrics/:id` (404 si no es del holding). */
	async get(id: string, holdingId: string) {
		const [row] = (await this.dataSource.query(`SELECT ${METRIC_SELECT} FROM billable_metrics bm WHERE bm.id = $1 AND bm.holding_id = $2`, [
			id,
			holdingId,
		])) as Row[];

		if (!row) throw new NotFoundException('Métrica facturable no encontrada');

		return BillableMetricsService.toView(row);
	}

	/** `POST /billable-metrics`: código único por holding (400 con `errors[code]`). */
	async create(dto: CreateBillableMetricDto, holdingId: string, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);
		const [taken] = (await this.dataSource.query(`SELECT id FROM billable_metrics WHERE holding_id = $1 AND code = $2`, [
			holdingId,
			dto.code,
		])) as Row[];

		if (taken) throw validationException([{ field: 'code', message: METRIC_CODE_TAKEN_MESSAGE }]);
		// Costura: toda escritura v2 corre en una transacción con `sapira.writer = 'api'`.
		const [row] = (await withApiWriter(this.dataSource, (runner) =>
			runner.query(
				`INSERT INTO billable_metrics (holding_id, code, name, description, aggregation, unit, source_kind, source_config, status, created_by, updated_by)
			VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'active', $9, $9) RETURNING id`,
				[
					holdingId,
					dto.code,
					dto.name,
					dto.description ?? null,
					dto.aggregation,
					dto.unit,
					dto.source_kind ?? 'manual',
					JSON.stringify(dto.source_config ?? {}),
					userId,
				]
			)
		)) as Row[];

		return await this.get(String(row.id), holdingId);
	}

	/** `PATCH /billable-metrics/:id`: nombre, descripción, agregación, unidad y fuente; el código no cambia. */
	async update(id: string, dto: UpdateBillableMetricDto, holdingId: string, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);
		const current = await this.get(id, holdingId);

		if (current.status === 'archived') throw new ConflictException('La métrica está archivada: no se edita');
		await withApiWriter(this.dataSource, (runner) =>
			runner.query(
				`UPDATE billable_metrics SET name = $3, description = $4, aggregation = $5, unit = $6, source_kind = $7, source_config = $8::jsonb,
				updated_at = now(), updated_by = $9
			WHERE id = $1 AND holding_id = $2`,
				[
					id,
					holdingId,
					dto.name ?? current.name,
					dto.description === undefined ? current.description : dto.description,
					dto.aggregation ?? current.aggregation,
					dto.unit ?? current.unit,
					dto.source_kind ?? current.source_kind,
					JSON.stringify(dto.source_config ?? current.source_config ?? {}),
					userId,
				]
			)
		);

		return await this.get(id, holdingId);
	}

	/** `POST /billable-metrics/:id/archive`: 409 si tiene precios activos (spec §2.1). */
	async archive(id: string, holdingId: string, authId: string) {
		const userId = await resolveUserId(this.dataSource, authId);
		const current = await this.get(id, holdingId);

		if (current.status === 'archived') return current;
		if (current.prices_count > 0) throw new ConflictException(METRIC_IN_USE_MESSAGE);
		await withApiWriter(this.dataSource, (runner) =>
			runner.query(
				`UPDATE billable_metrics SET status = 'archived', archived_at = now(), updated_at = now(), updated_by = $3 WHERE id = $1 AND holding_id = $2`,
				[id, holdingId, userId]
			)
		);

		return await this.get(id, holdingId);
	}
}
