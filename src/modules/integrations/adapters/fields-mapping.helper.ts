import { NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';
import type { SalesforceMappingService } from '@/modules/salesforce/services/salesforce-mapping.service';

import { buildMappingView, filterRefs, MappingItem, MappingRow, MappingStatus, MappingView, Ref } from '../integrations.types';

type Row = Record<string, unknown>;
type Entry = Record<string, unknown>;

const SECTION_LABELS: Record<string, string> = { mappings: 'Campos', header_mappings: 'Encabezado', line_mappings: 'Líneas' };

/** Campo de origen de una entrada de `field_mappings.mapping_config` (las dos formas que guarda la app actual). */
const sourceOf = (entry: Entry): string | null => {
	const value = entry.source ?? entry.odoo_field ?? (entry.sourceField as Entry | undefined)?.name;

	return typeof value === 'string' && value.trim() ? value : null;
};

const transformationOf = (entry: Entry): string | null => {
	const value = entry.transformation ?? entry.transformation_type ?? null;

	return typeof value === 'string' ? value : null;
};

/** Secciones de un `mapping_config`: claves cuyo valor es un objeto de entradas (`mappings`, `header_mappings`, `line_mappings`). */
const sectionsOf = (config: Record<string, unknown> | null): Array<[string, Record<string, Entry>]> =>
	Object.entries(config ?? {}).filter(
		(entry): entry is [string, Record<string, Entry>] =>
			Boolean(entry[1]) &&
			typeof entry[1] === 'object' &&
			!Array.isArray(entry[1]) &&
			Object.values(entry[1] as object).every((value) => value && typeof value === 'object' && !Array.isArray(value))
	);

/**
 * Mapeo de campos (A1, ajuste 1 de Domi) con la forma común de mapeos. ERP: `field_mappings.mapping_config` (se edita solo el campo de
 * origen; las transformaciones quedan como están). CRM: `salesforce_field_mappings` vía `SalesforceMappingService`. La lógica que aplica
 * el mapeo no cambia.
 */
export class FieldsMappingHelper {
	constructor(private readonly dataSource: DataSource) {}

	private async erpConfigs(holdingId: string): Promise<Row[]> {
		return (await this.dataSource.query(
			`SELECT id, source_model, target_table, mapping_name, mapping_config FROM field_mappings WHERE holding_id = $1 AND is_active = true ORDER BY source_model, target_table`,
			[holdingId]
		)) as Row[];
	}

	async erpView(holdingId: string, query: { status?: MappingStatus; search?: string }): Promise<MappingView> {
		const rows: MappingRow[] = (await this.erpConfigs(holdingId)).flatMap((config) =>
			sectionsOf(config.mapping_config as Record<string, unknown>).flatMap(([section, entries]) =>
				Object.entries(entries).map(([target, entry]) => {
					const source = sourceOf(entry);
					const id = `${config.id}:${section}:${target}`;

					return {
						key: id,
						sapira: {
							id,
							label: `${config.target_table} · ${target}`,
							meta: {
								source_model: config.source_model,
								target_table: config.target_table,
								section,
								section_label: SECTION_LABELS[section] ?? section,
							},
						},
						external: source ? { id: source, label: source, meta: {} } : null,
						status: source ? 'mapped' : 'unmapped',
						suggestion: null,
						usage: null,
						meta: { transformation: transformationOf(entry) },
					} satisfies MappingRow;
				})
			)
		);

		return buildMappingView(
			{ object: 'fields', object_label: 'Campos', anchor: 'sapira', external_available: true, external_error: null },
			rows,
			query
		);
	}

	async erpOptions(holdingId: string, search?: string) {
		const sources = new Set<string>();

		for (const config of await this.erpConfigs(holdingId)) {
			for (const [, entries] of sectionsOf(config.mapping_config as Record<string, unknown>)) {
				for (const entry of Object.values(entries)) {
					const source = sourceOf(entry);

					if (source) sources.add(source);
				}
			}
		}
		const refs: Ref[] = [...sources].sort().map((source) => ({ id: source, label: source, meta: {} }));

		return { data: filterRefs(refs, search), available: true, error: null };
	}

	private parseErpKey(key: string): { id: string; section: string; target: string } | null {
		const [id, section, ...rest] = key.split(':');

		return id && section && rest.length ? { id, section, target: rest.join(':') } : null;
	}

	private async updateErpEntry(holdingId: string, key: string, change: (entries: Record<string, Entry>, target: string) => void, field: string) {
		const parsed = this.parseErpKey(key);

		if (!parsed) throw validationException([{ field, message: 'Campo inválido' }]);
		const [config] = (await this.dataSource.query(`SELECT mapping_config FROM field_mappings WHERE id::text = $1 AND holding_id = $2`, [
			parsed.id,
			holdingId,
		])) as Row[];
		const mapping = (config?.mapping_config ?? null) as Record<string, Record<string, Entry>> | null;

		if (!mapping?.[parsed.section]?.[parsed.target]) throw new NotFoundException('Mapeo no encontrado');
		change(mapping[parsed.section], parsed.target);
		await this.dataSource.query(
			`UPDATE field_mappings SET mapping_config = $3::jsonb, updated_at = now() WHERE id::text = $1 AND holding_id = $2`,
			[parsed.id, holdingId, JSON.stringify(mapping)]
		);
	}

	async erpPut(holdingId: string, items: MappingItem[]): Promise<void> {
		for (const [index, item] of items.entries()) {
			const source = item.external_id.trim();

			await this.updateErpEntry(
				holdingId,
				item.sapira_id,
				(entries, target) => {
					const entry = entries[target];

					if ('odoo_field' in entry) entry.odoo_field = source;
					else entry.source = source;
				},
				`items.${index}.sapira_id`
			);
		}
	}

	async erpDelete(holdingId: string, key: string): Promise<void> {
		await this.updateErpEntry(
			holdingId,
			key,
			(entries, target) => {
				delete entries[target];
			},
			'sapira_id'
		);
	}

	// ── CRM ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

	async crmView(service: SalesforceMappingService, holdingId: string, query: { status?: MappingStatus; search?: string }): Promise<MappingView> {
		const mappings = await service.getFieldMappings(holdingId);
		const rows: MappingRow[] = mappings.map((mapping) => {
			const id = `${mapping.object_type}.${mapping.sapira_field}`;

			return {
				key: mapping.id,
				sapira: {
					id,
					label: `${mapping.object_type} · ${mapping.sapira_field}`,
					meta: {
						object_type: mapping.object_type,
						mapping_id: mapping.id,
						is_required: mapping.is_required,
						is_active: mapping.is_active,
					},
				},
				external: mapping.salesforce_field ? { id: mapping.salesforce_field, label: mapping.salesforce_field, meta: {} } : null,
				status: mapping.salesforce_field && mapping.is_active ? 'mapped' : 'unmapped',
				suggestion: null,
				usage: null,
				meta: { transformation_key: mapping.transformation_key ?? null },
			};
		});

		return buildMappingView(
			{ object: 'fields', object_label: 'Campos', anchor: 'sapira', external_available: true, external_error: null },
			rows,
			query
		);
	}

	async crmOptions(service: SalesforceMappingService, holdingId: string, search?: string) {
		const fields = [...new Set((await service.getFieldMappings(holdingId)).map((mapping) => mapping.salesforce_field).filter(Boolean))].sort();

		return {
			data: filterRefs(
				fields.map((field) => ({ id: field, label: field, meta: {} })),
				search
			),
			available: true,
			error: null,
		};
	}

	/** `sapira_id` = `<object_type>.<campo>`: actualiza el mapeo existente o crea uno nuevo para ese campo. */
	async crmPut(service: SalesforceMappingService, holdingId: string, items: MappingItem[]): Promise<void> {
		const mappings = await service.getFieldMappings(holdingId);

		for (const [index, item] of items.entries()) {
			const [objectType, ...rest] = item.sapira_id.split('.');
			const sapiraField = rest.join('.');

			if (!objectType || !sapiraField) throw validationException([{ field: `items.${index}.sapira_id`, message: 'Campo inválido' }]);
			const existing = mappings.find((mapping) => mapping.object_type === objectType && mapping.sapira_field === sapiraField);
			const transformation = typeof item.meta?.transformation_key === 'string' ? (item.meta.transformation_key as string) : undefined;

			if (existing) {
				await service.updateFieldMapping(existing.id, holdingId, {
					salesforce_field: item.external_id,
					is_active: true,
					...(transformation ? { transformation_key: transformation } : {}),
				} as never);
			} else {
				await service.createFieldMapping(holdingId, {
					object_type: objectType,
					sapira_field: sapiraField,
					salesforce_field: item.external_id,
					...(transformation ? { transformation_key: transformation } : {}),
				} as never);
			}
		}
	}

	async crmDelete(service: SalesforceMappingService, holdingId: string, sapiraId: string): Promise<void> {
		const [objectType, ...rest] = sapiraId.split('.');
		const existing = (await service.getFieldMappings(holdingId)).find(
			(mapping) => mapping.object_type === objectType && mapping.sapira_field === rest.join('.')
		);

		if (!existing) throw new NotFoundException('Mapeo no encontrado');
		await service.deleteFieldMapping(existing.id, holdingId);
	}
}
