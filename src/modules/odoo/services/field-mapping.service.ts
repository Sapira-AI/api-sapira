import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { FieldMapping } from '@/databases/postgresql/entities/field-mapping.entity';

import { FieldTransformationService, TransformationConfig, TransformationType } from './field-transformation.service';

export interface MappingEntry {
	odoo_field: string;
	sapira_field: string;
	transformation_type?: TransformationType;
	transformation_config?: TransformationConfig;
}

export interface MappingConfig {
	invoice_mappings?: Record<string, MappingEntry>;
	line_mappings?: Record<string, MappingEntry>;
}

@Injectable()
export class FieldMappingService {
	constructor(
		@InjectRepository(FieldMapping)
		private readonly fieldMappingRepository: Repository<FieldMapping>,
		private readonly fieldTransformationService: FieldTransformationService
	) {}

	async getMappingConfig(holdingId: string, sourceModel: string, targetTable: string): Promise<MappingConfig | null> {
		const fieldMapping = await this.fieldMappingRepository.findOne({
			where: {
				holding_id: holdingId,
				source_model: sourceModel,
				target_table: targetTable,
				mapping_type: 'hierarchical',
				is_active: true,
			},
		});

		if (!fieldMapping || !fieldMapping.mapping_config) {
			return null;
		}

		return fieldMapping.mapping_config as MappingConfig;
	}

	async applyFieldMappingToData(
		sourceData: Record<string, any>,
		mappingConfig: Record<string, MappingEntry>,
		targetTable: string,
		holdingId: string
	): Promise<Record<string, any>> {
		const result: Record<string, any> = {};

		if (!mappingConfig) {
			return result;
		}

		for (const [fieldKey, mappingEntry] of Object.entries(mappingConfig)) {
			const odooField = mappingEntry.odoo_field;
			const sapiraField = mappingEntry.sapira_field || fieldKey;
			const transformationType = mappingEntry.transformation_type || TransformationType.DIRECT;
			const transformationConfig = mappingEntry.transformation_config || null;

			if (!odooField) {
				continue;
			}

			const sourceValue = this.extractSourceValue(sourceData, odooField);

			if (sourceValue === null || sourceValue === undefined) {
				continue;
			}

			const sourceValueStr = String(sourceValue);

			try {
				const finalValue = await this.fieldTransformationService.resolveFieldTransformation(
					transformationType,
					transformationConfig,
					sourceValueStr,
					holdingId
				);

				if (finalValue !== null && finalValue !== undefined) {
					result[sapiraField] = finalValue;
				}
			} catch (error) {
				console.error(`Error aplicando transformación para campo ${sapiraField}:`, error.message);
				result[sapiraField] = sourceValueStr;
			}
		}

		return result;
	}

	private extractSourceValue(sourceData: Record<string, any>, odooField: string): any {
		if (odooField.includes('[') && odooField.includes(']')) {
			const fieldName = odooField.split('[')[0];
			const indexMatch = odooField.match(/\[(\d+)\]/);

			if (indexMatch) {
				const arrayIndex = parseInt(indexMatch[1], 10);
				const arrayValue = sourceData[fieldName];

				if (Array.isArray(arrayValue) && arrayValue.length > arrayIndex) {
					if (Array.isArray(arrayValue[arrayIndex])) {
						return arrayValue[arrayIndex][0];
					}
					return arrayValue[arrayIndex];
				}
			}

			return null;
		}

		return sourceData[odooField];
	}

	cleanFieldPrefixes(data: Record<string, any>, prefix: string): Record<string, any> {
		const cleaned: Record<string, any> = {};

		for (const [key, value] of Object.entries(data)) {
			if (key.startsWith(prefix)) {
				const cleanKey = key.replace(new RegExp(`^${prefix}`), '');
				cleaned[cleanKey] = value;
			} else {
				cleaned[key] = value;
			}
		}

		return cleaned;
	}
}
