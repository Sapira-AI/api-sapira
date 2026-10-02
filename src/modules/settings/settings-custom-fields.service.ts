import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { plural, Row, toCount, withUniqueMessage } from './settings-common';

import type { CreateCustomFieldDto, CustomFieldEntityType, CustomFieldsQueryDto, UpdateCustomFieldDto } from './dtos/custom-fields.dto';

/**
 * Tabla con la columna `custom_fields jsonb` de cada entidad. `quote` no tiene columna (`quotes` no guarda campos personalizados):
 * sus definiciones nunca tienen valores.
 */
export const CUSTOM_FIELD_TABLES: Record<CustomFieldEntityType, string | null> = {
	client: 'clients',
	contract: 'contracts',
	contract_item: 'contract_items',
	quote: null,
	quote_item: 'quote_items',
	invoice: 'invoices',
	invoice_item: 'invoice_items',
};

const DUPLICATE = 'Ya existe un campo con ese nombre interno para esta entidad';

/**
 * Campos personalizados del holding (D13): definiciones en `custom_field_definitions`. Mostrarlos y editarlos en los formularios de los
 * módulos cerrados va con OK por módulo. Borrar solo si ninguna fila tiene valor; si no, desactivar.
 */
@Injectable()
export class SettingsCustomFieldsService {
	constructor(private readonly dataSource: DataSource) {}

	/** Filas del holding con valor no vacío para el campo. */
	async valuesCount(holdingId: string, entityType: CustomFieldEntityType, fieldName: string): Promise<number> {
		const table = CUSTOM_FIELD_TABLES[entityType];

		if (!table) return 0;
		const [row] = (await this.dataSource.query(
			`SELECT count(*) AS n FROM ${table} WHERE holding_id = $1 AND NULLIF(btrim(custom_fields ->> $2), '') IS NOT NULL`,
			[holdingId, fieldName]
		)) as Row[];

		return toCount(row?.n);
	}

	private async toDto(holdingId: string, row: Row) {
		return {
			id: String(row.id),
			entity_type: String(row.entity_type),
			field_name: String(row.field_name),
			field_label: String(row.field_label),
			field_type: String(row.field_type),
			is_required: row.is_required === true,
			is_active: row.is_active === true,
			display_order: Number(row.display_order ?? 0),
			created_at: row.created_at,
			values_count: await this.valuesCount(holdingId, row.entity_type as CustomFieldEntityType, String(row.field_name)),
		};
	}

	async list(holdingId: string, query: CustomFieldsQueryDto = {}) {
		const params: unknown[] = [holdingId];
		const filter = query.entity_type ? `AND entity_type = $${params.push(query.entity_type)}` : '';
		const rows = (await this.dataSource.query(
			`SELECT * FROM custom_field_definitions WHERE holding_id = $1 ${filter} ORDER BY entity_type, display_order, created_at`,
			params
		)) as Row[];

		return Promise.all(rows.map((row) => this.toDto(holdingId, row)));
	}

	private async find(holdingId: string, id: string): Promise<Row> {
		const [row] = (await this.dataSource.query(`SELECT * FROM custom_field_definitions WHERE id = $1 AND holding_id = $2`, [
			id,
			holdingId,
		])) as Row[];

		if (!row) throw new NotFoundException('Campo personalizado no encontrado');

		return row;
	}

	async create(holdingId: string, dto: CreateCustomFieldDto, userId: string | null) {
		const [row] = await withUniqueMessage(
			async () =>
				(await this.dataSource.query(
					`INSERT INTO custom_field_definitions (holding_id, entity_type, field_name, field_label, field_type, is_required, is_active, display_order, created_by)
					VALUES ($1, $2, $3, $4, $5, $6, true,
						COALESCE($7, (SELECT COALESCE(max(display_order) + 1, 0) FROM custom_field_definitions WHERE holding_id = $1 AND entity_type = $2)),
						$8)
					RETURNING *`,
					[
						holdingId,
						dto.entity_type,
						dto.field_name,
						dto.field_label,
						dto.field_type,
						dto.is_required ?? false,
						dto.display_order ?? null,
						userId,
					]
				)) as Row[],
			DUPLICATE
		);

		return this.toDto(holdingId, row);
	}

	async update(holdingId: string, id: string, dto: UpdateCustomFieldDto) {
		const current = await this.find(holdingId, id);
		const changesShape =
			(dto.field_name !== undefined && dto.field_name !== current.field_name) ||
			(dto.field_type !== undefined && dto.field_type !== current.field_type);

		if (changesShape && (await this.valuesCount(holdingId, current.entity_type as CustomFieldEntityType, String(current.field_name))) > 0) {
			throw new ConflictException('Este campo ya tiene valores guardados: no se puede cambiar su nombre interno ni su tipo');
		}
		const [row] = await withUniqueMessage(
			async () =>
				(await this.dataSource.query(
					`UPDATE custom_field_definitions SET field_name = $3, field_label = $4, field_type = $5, is_required = $6, is_active = $7, display_order = $8
					WHERE id = $1 AND holding_id = $2 RETURNING *`,
					[
						id,
						holdingId,
						dto.field_name ?? current.field_name,
						dto.field_label ?? current.field_label,
						dto.field_type ?? current.field_type,
						dto.is_required ?? current.is_required,
						dto.is_active ?? current.is_active,
						dto.display_order ?? current.display_order,
					]
				)) as Row[],
			DUPLICATE
		);

		return this.toDto(holdingId, row);
	}

	async remove(holdingId: string, id: string): Promise<void> {
		const current = await this.find(holdingId, id);
		const count = await this.valuesCount(holdingId, current.entity_type as CustomFieldEntityType, String(current.field_name));

		if (count > 0) {
			throw new ConflictException(`Este campo tiene valores en ${plural(count, 'registro', 'registros')}: desactívalo en vez de eliminarlo`);
		}
		await this.dataSource.query(`DELETE FROM custom_field_definitions WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}
}
