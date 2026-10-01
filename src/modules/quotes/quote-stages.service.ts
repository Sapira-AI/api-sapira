import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { type FieldError, validationException } from '@/core/utils/validation-errors';
import { setApiWriter } from '@/modules/contracts/api-writer';
import { resolveUserId } from '@/modules/contracts/contract-drafts.service';

import { isStageKind, type QuoteStageKind, SINGLE_STAGE_KINDS } from './quote-status';
import { conflict } from './quotes.service';

import type { UpdateQuoteStagesDto } from './dtos/quote-stage.dto';

type Row = Record<string, unknown>;

const toText = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));
const toNumber = (value: unknown) => Number(value ?? 0) || 0;

export interface QuoteStageView {
	id: string;
	name: string;
	color: string | null;
	kind: QuoteStageKind;
	position: number;
	is_system_stage: boolean;
	is_deletable: boolean;
	quotes_count: number;
}

/**
 * Etapas de cotización del holding (mapa §1.5 y §6): lectura y `PUT` con la lista completa y ordenada (crear, renombrar, recolorear,
 * cambiar `kind`, reordenar y eliminar en una transacción). Reglas: `signed` y `lost` admiten una sola etapa por holding (UNIQUE
 * parcial; `contract_created` admite varias, p. ej. "Contrato creado" y "Procesada previamente"); tiene que existir al menos una `draft`; no se elimina una etapa con cotizaciones (409) ni una de sistema
 * (`is_deletable = false`). Reordenar pasa por posiciones negativas y luego finales por el UNIQUE (holding, position).
 */
@Injectable()
export class QuoteStagesService {
	constructor(private readonly dataSource: DataSource) {}

	async list(holdingId: string): Promise<{ data: QuoteStageView[] }> {
		const rows = await this.dataSource.query<Row[]>(
			`SELECT qs.id, qs.name, qs.color, qs.kind, qs.position, qs.is_system_stage, qs.is_deletable,
				(SELECT COUNT(*) FROM quotes q WHERE q.quote_stage_id = qs.id AND q.deleted_at IS NULL) AS quotes_count
			FROM quote_stages qs WHERE qs.holding_id = $1 ORDER BY qs.position, qs.name`,
			[holdingId]
		);

		return { data: rows.map(QuoteStagesService.view) };
	}

	static view(row: Row): QuoteStageView {
		return {
			id: String(row.id),
			name: String(row.name),
			color: toText(row.color),
			kind: isStageKind(row.kind) ? row.kind : 'draft',
			position: toNumber(row.position),
			is_system_stage: row.is_system_stage === true,
			is_deletable: row.is_deletable !== false,
			quotes_count: toNumber(row.quotes_count),
		};
	}

	/** Validación pura de la lista pedida: nombres únicos, un solo `signed` y un solo `lost` (varios `contract_created` valen), al menos un `draft`. */
	static validate(stages: UpdateQuoteStagesDto['stages']): FieldError[] {
		const errors: FieldError[] = [];
		const names = new Map<string, number>();
		const singles = new Map<QuoteStageKind, number>();

		stages.forEach((stage, index) => {
			const key = stage.name.trim().toLowerCase();

			if (names.has(key)) errors.push({ field: `stages.${index}.name`, message: `La etapa "${stage.name}" está repetida` });
			names.set(key, index);
			if (SINGLE_STAGE_KINDS.includes(stage.kind)) {
				if (singles.has(stage.kind))
					errors.push({ field: `stages.${index}.kind`, message: `Solo puede haber una etapa de tipo ${stage.kind} por holding` });
				singles.set(stage.kind, index);
			}
		});
		if (!stages.some((stage) => stage.kind === 'draft'))
			errors.push({ field: 'stages', message: 'Tiene que haber al menos una etapa de tipo borrador (draft)' });

		return errors;
	}

	/** `PUT /quote-stages`: aplica la lista completa en una transacción y devuelve las etapas resultantes. */
	async replace(dto: UpdateQuoteStagesDto, holdingId: string, authId: string) {
		await resolveUserId(this.dataSource, authId);
		const errors = QuoteStagesService.validate(dto.stages);

		if (errors.length) throw validationException(errors);
		const runner = this.dataSource.createQueryRunner();

		await runner.connect();
		await runner.startTransaction();
		// Costura `sapira.writer = 'api'`: primera sentencia de la transacción v2.
		await setApiWriter(runner);
		try {
			const existing = (await runner.query(
				`SELECT qs.id, qs.name, qs.kind, qs.is_deletable, (SELECT COUNT(*) FROM quotes q WHERE q.quote_stage_id = qs.id) AS quotes_count
				FROM quote_stages qs WHERE qs.holding_id = $1 FOR UPDATE`,
				[holdingId]
			)) as Row[];
			const existingById = new Map(existing.map((row) => [String(row.id), row]));
			const fieldErrors: FieldError[] = [];

			dto.stages.forEach((stage, index) => {
				if (stage.id && !existingById.has(stage.id))
					fieldErrors.push({ field: `stages.${index}.id`, message: 'La etapa no pertenece al holding' });
			});
			if (fieldErrors.length) throw validationException(fieldErrors);
			const keep = new Set(dto.stages.map((stage) => stage.id).filter(Boolean));
			const toDelete = existing.filter((row) => !keep.has(String(row.id)));
			const blocked = toDelete.find((row) => toNumber(row.quotes_count) > 0 || row.is_deletable === false);

			if (blocked) {
				throw conflict(
					'stage_in_use',
					toNumber(blocked.quotes_count) > 0
						? `La etapa "${String(blocked.name)}" tiene ${toNumber(blocked.quotes_count)} cotización(es): muévelas antes de eliminarla`
						: `La etapa "${String(blocked.name)}" es de sistema y no se elimina`
				);
			}
			if (toDelete.length) {
				await runner.query(`DELETE FROM quote_stages WHERE id = ANY($1::uuid[]) AND holding_id = $2`, [
					toDelete.map((row) => String(row.id)),
					holdingId,
				]);
			}
			// Posiciones negativas primero: el UNIQUE (holding, position) no admite el intercambio directo.
			await runner.query(`UPDATE quote_stages SET position = -1 - position WHERE holding_id = $1`, [holdingId]);
			const ids: string[] = [];

			for (const [index, stage] of dto.stages.entries()) {
				if (stage.id) {
					await runner.query(
						`UPDATE quote_stages SET name = $3, color = COALESCE($4, color), kind = $5, position = $6 WHERE id = $1 AND holding_id = $2`,
						[stage.id, holdingId, stage.name.trim(), stage.color ?? null, stage.kind, index]
					);
					ids.push(stage.id);
				} else {
					const [row] = (await runner.query(
						`INSERT INTO quote_stages (holding_id, name, color, kind, position, is_system_stage, is_deletable)
						VALUES ($1, $2, COALESCE($3, '#3B82F6'), $4, $5, false, true) RETURNING id`,
						[holdingId, stage.name.trim(), stage.color ?? null, stage.kind, index]
					)) as Row[];

					ids.push(String(row.id));
				}
			}
			await runner.commitTransaction();
		} catch (error) {
			await runner.rollbackTransaction();
			throw error;
		} finally {
			await runner.release();
		}

		return await this.list(holdingId);
	}
}
