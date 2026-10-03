import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { plural, Row, toCount, withUniqueMessage } from './settings-common';

import type {
	CreateCustomFieldDto,
	CustomFieldEntityType,
	CustomFieldOptionDto,
	CustomFieldsQueryDto,
	CustomFieldType,
	UpdateCustomFieldDto,
} from './dtos/custom-fields.dto';

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

type FieldOption = { value: string; label: string };

const parseOptions = (value: unknown): FieldOption[] | null => {
	let raw = value;

	if (typeof raw === 'string') {
		try {
			raw = JSON.parse(raw);
		} catch {
			return null;
		}
	}

	return Array.isArray(raw) ? (raw as FieldOption[]).map((option) => ({ value: String(option.value), label: String(option.label) })) : null;
};

/**
 * Opciones según el tipo (ronda 3): obligatorias en `select` (sin valores repetidos, sin distinguir mayúsculas) y prohibidas en el resto.
 * Devuelve lo que se guarda (`null` fuera de `select`).
 */
export function cleanFieldOptions(
	fieldType: CustomFieldType | string,
	options: CustomFieldOptionDto[] | FieldOption[] | null | undefined
): FieldOption[] | null {
	if (fieldType !== 'select') {
		if (options && options.length) throw new BadRequestException('Solo los campos de lista tienen opciones');

		return null;
	}
	if (!options || !options.length) throw new BadRequestException('Las opciones son obligatorias para un campo de lista');
	const seen = new Set<string>();

	for (const option of options) {
		const key = option.value.trim().toLowerCase();

		if (seen.has(key)) throw new BadRequestException(`Opción repetida: ${option.label}`);
		seen.add(key);
	}

	return options.map((option) => ({ value: option.value.trim(), label: option.label.trim() }));
}

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

	/**
	 * Conteo agrupado: una consulta por entidad para todos sus campos (antes, una por campo). Mismo criterio que `valuesCount`.
	 * Devuelve `entity_type:field_name` → filas con valor.
	 */
	private async valuesCountByField(holdingId: string, rows: Row[]): Promise<Map<string, number>> {
		const byEntity = new Map<CustomFieldEntityType, string[]>();

		for (const row of rows) {
			const entity = row.entity_type as CustomFieldEntityType;

			byEntity.set(entity, [...(byEntity.get(entity) ?? []), String(row.field_name)]);
		}
		const counts = new Map<string, number>();

		await Promise.all(
			[...byEntity.entries()].map(async ([entity, names]) => {
				const table = CUSTOM_FIELD_TABLES[entity];

				if (!table) return;
				const result = (await this.dataSource.query(
					`SELECT f.name, count(t.*) AS n
					FROM unnest($2::text[]) AS f(name)
					JOIN ${table} t ON t.holding_id = $1 AND NULLIF(btrim(t.custom_fields ->> f.name), '') IS NOT NULL
					GROUP BY f.name`,
					[holdingId, [...new Set(names)]]
				)) as Row[];

				for (const item of result) counts.set(`${entity}:${String(item.name)}`, toCount(item.n));
			})
		);

		return counts;
	}

	/** Registros del holding por opción de un campo `select` (valor exacto guardado en `custom_fields`). */
	async optionUsage(
		holdingId: string,
		entityType: CustomFieldEntityType,
		fieldName: string,
		options: FieldOption[]
	): Promise<Record<string, number>> {
		const usage = Object.fromEntries(options.map((option) => [option.value, 0]));
		const table = CUSTOM_FIELD_TABLES[entityType];

		if (!table || !options.length) return usage;
		const rows = (await this.dataSource.query(
			`SELECT custom_fields ->> $2 AS value, count(*) AS n FROM ${table}
			WHERE holding_id = $1 AND custom_fields ->> $2 = ANY($3::text[]) GROUP BY 1`,
			[holdingId, fieldName, options.map((option) => option.value)]
		)) as Row[];

		for (const row of rows) usage[String(row.value)] = toCount(row.n);

		return usage;
	}

	private async withOptionUsage(holdingId: string, row: Row) {
		const options = parseOptions(row.options);

		return String(row.field_type) === 'select' && options
			? await this.optionUsage(holdingId, row.entity_type as CustomFieldEntityType, String(row.field_name), options)
			: null;
	}

	private toDto(row: Row, valuesCount: number, optionUsage: Record<string, number> | null = null) {
		return {
			id: String(row.id),
			entity_type: String(row.entity_type),
			field_name: String(row.field_name),
			field_label: String(row.field_label),
			field_type: String(row.field_type),
			is_required: row.is_required === true,
			is_active: row.is_active === true,
			display_order: Number(row.display_order ?? 0),
			options: parseOptions(row.options),
			option_usage: optionUsage,
			created_at: row.created_at,
			values_count: valuesCount,
		};
	}

	private async toDtoWithCount(holdingId: string, row: Row) {
		return this.toDto(
			row,
			await this.valuesCount(holdingId, row.entity_type as CustomFieldEntityType, String(row.field_name)),
			await this.withOptionUsage(holdingId, row)
		);
	}

	async list(holdingId: string, query: CustomFieldsQueryDto = {}) {
		const params: unknown[] = [holdingId];
		const filter = query.entity_type ? `AND entity_type = $${params.push(query.entity_type)}` : '';
		const rows = (await this.dataSource.query(
			`SELECT * FROM custom_field_definitions WHERE holding_id = $1 ${filter} ORDER BY entity_type, display_order, created_at`,
			params
		)) as Row[];

		const counts = await this.valuesCountByField(holdingId, rows);
		const optionUsage = await Promise.all(rows.map((row) => this.withOptionUsage(holdingId, row)));

		return rows.map((row, index) => this.toDto(row, counts.get(`${String(row.entity_type)}:${String(row.field_name)}`) ?? 0, optionUsage[index]));
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
		const options = cleanFieldOptions(dto.field_type, dto.options);
		const [row] = await withUniqueMessage(
			async () =>
				(await this.dataSource.query(
					`INSERT INTO custom_field_definitions (holding_id, entity_type, field_name, field_label, field_type, is_required, is_active, display_order, created_by, options)
					VALUES ($1, $2, $3, $4, $5, $6, true,
						COALESCE($7, (SELECT COALESCE(max(display_order) + 1, 0) FROM custom_field_definitions WHERE holding_id = $1 AND entity_type = $2)),
						$8, $9::jsonb)
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
						options ? JSON.stringify(options) : null,
					]
				)) as Row[],
			DUPLICATE
		);

		return this.toDtoWithCount(holdingId, row);
	}

	async update(holdingId: string, id: string, dto: UpdateCustomFieldDto) {
		const current = await this.find(holdingId, id);
		const changesShape =
			(dto.field_name !== undefined && dto.field_name !== current.field_name) ||
			(dto.field_type !== undefined && dto.field_type !== current.field_type);

		if (changesShape && (await this.valuesCount(holdingId, current.entity_type as CustomFieldEntityType, String(current.field_name))) > 0) {
			throw new ConflictException('Este campo ya tiene valores guardados: no se puede cambiar su nombre interno ni su tipo');
		}
		const fieldType = dto.field_type ?? String(current.field_type);
		const currentOptions = parseOptions(current.options) ?? [];
		// Sin `options` en el body: se conservan (salvo que el tipo deje de ser lista).
		const options = cleanFieldOptions(fieldType, dto.options !== undefined ? dto.options : fieldType === 'select' ? currentOptions : null);

		if (String(current.field_type) === 'select' && currentOptions.length) {
			const kept = new Set((options ?? []).map((option) => option.value));
			const removed = currentOptions.filter((option) => !kept.has(option.value));

			if (removed.length) {
				const usage = await this.optionUsage(holdingId, current.entity_type as CustomFieldEntityType, String(current.field_name), removed);
				const used = removed.find((option) => (usage[option.value] ?? 0) > 0);

				if (used) {
					throw new ConflictException(
						`La opción "${used.label}" está en ${plural(usage[used.value], 'registro', 'registros')}: no se puede quitar`
					);
				}
			}
		}
		const [row] = await withUniqueMessage(
			async () =>
				(await this.dataSource.query(
					`UPDATE custom_field_definitions SET field_name = $3, field_label = $4, field_type = $5, is_required = $6, is_active = $7, display_order = $8,
						options = $9::jsonb
					WHERE id = $1 AND holding_id = $2 RETURNING *`,
					[
						id,
						holdingId,
						dto.field_name ?? current.field_name,
						dto.field_label ?? current.field_label,
						fieldType,
						dto.is_required ?? current.is_required,
						dto.is_active ?? current.is_active,
						dto.display_order ?? current.display_order,
						options ? JSON.stringify(options) : null,
					]
				)) as Row[],
			DUPLICATE
		);

		return this.toDtoWithCount(holdingId, row);
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
