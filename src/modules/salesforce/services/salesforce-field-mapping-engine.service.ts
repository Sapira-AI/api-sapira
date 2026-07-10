import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
	buildCustomFields,
	formatAddress,
	generateClientNumber,
	isoToCountryName,
	isRecurring,
	parseSalesforceDate,
	transformBillingMethod,
	transformToBoolean,
} from '../utils/salesforce-transformers';
import { SalesforceFieldMapping, SalesforceFieldMappingObjectType } from '../entities/salesforce-field-mapping.entity';
import { SalesforceQuoteTypeMapping } from '../entities/salesforce-quote-type-mapping.entity';

import { SalesforceMappingService } from './salesforce-mapping.service';

interface MappingContext {
	opportunity?: Record<string, any>;
	lineItem?: Record<string, any>;
}

@Injectable()
export class SalesforceFieldMappingEngineService {
	constructor(
		@InjectRepository(SalesforceFieldMapping)
		private readonly fieldMappingRepository: Repository<SalesforceFieldMapping>,
		@InjectRepository(SalesforceQuoteTypeMapping)
		private readonly quoteTypeMappingRepository: Repository<SalesforceQuoteTypeMapping>,
		private readonly salesforceMappingService: SalesforceMappingService
	) {}

	async getActiveMappings(holdingId: string, objectType: SalesforceFieldMappingObjectType): Promise<SalesforceFieldMapping[]> {
		await this.salesforceMappingService.ensureDefaultFieldMappings(holdingId, objectType);

		return this.fieldMappingRepository.find({
			where: {
				holding_id: holdingId,
				object_type: objectType,
				is_active: true,
			},
			order: {
				sapira_field: 'ASC',
			},
		});
	}

	async buildMappedRecord(
		holdingId: string,
		objectType: SalesforceFieldMappingObjectType,
		sourceRecord: Record<string, any>,
		context: MappingContext = {}
	): Promise<Record<string, any>> {
		const mappings = await this.getActiveMappings(holdingId, objectType);
		const result: Record<string, any> = {};

		for (const mapping of mappings) {
			const rawValue = this.extractSourceValue(sourceRecord, mapping.salesforce_field);
			const transformedValue = await this.transformMappedValue(holdingId, objectType, mapping.sapira_field, rawValue, sourceRecord, context, mapping.default_value);

			if (transformedValue === undefined || transformedValue === null || transformedValue === '') {
				continue;
			}

			result[mapping.sapira_field] = transformedValue;
		}

		return result;
	}

	private extractSourceValue(sourceRecord: Record<string, any>, path: string): any {
		if (!path) {
			return null;
		}

		if (path === 'custom_fields') {
			return path;
		}

		if (path.includes(',')) {
			return path.split(',').map((segment) => this.extractSourceValue(sourceRecord, segment.trim()));
		}

		return path.split('.').reduce<any>((current, key) => {
			if (current === null || current === undefined) {
				return null;
			}

			return current[key];
		}, sourceRecord);
	}

	private async transformMappedValue(
		holdingId: string,
		objectType: SalesforceFieldMappingObjectType,
		sapiraField: string,
		rawValue: any,
		sourceRecord: Record<string, any>,
		context: MappingContext,
		defaultValue?: string | null
	): Promise<any> {
		const fallbackValue = defaultValue ?? null;

		switch (sapiraField) {
			case 'client_number':
				return generateClientNumber(sourceRecord.Id, rawValue || fallbackValue || undefined);
			case 'country':
				return isoToCountryName(rawValue || fallbackValue);
			case 'legal_address': {
				const values = Array.isArray(rawValue) ? rawValue : [rawValue];
				return formatAddress(values[0], values[1], values[2], values[3], values[4]);
			}
			case 'quote_type':
				return this.resolveQuoteType(holdingId, rawValue || fallbackValue);
			case 'quote_date': {
				const created = parseSalesforceDate(rawValue || undefined);
				return created || parseSalesforceDate(sourceRecord.CloseDate || undefined);
			}
			case 'booking_date':
			case 'start_date':
			case 'end_date':
				return parseSalesforceDate(rawValue || undefined);
			case 'requires_contract_document':
			case 'requires_references_for_billing':
				return transformToBoolean(rawValue);
			case 'is_recurring':
				return isRecurring(rawValue || undefined);
			case 'billing_method':
				return transformBillingMethod(rawValue || context.opportunity?.Forma_de_pago__c || fallbackValue || undefined);
			case 'billing_frequency':
				return rawValue || context.opportunity?.Account?.Per_odo_de_facturaci_n__c || context.opportunity?.Modalidad_de_pago__c || fallbackValue;
			case 'custom_fields':
				return buildCustomFields(context.lineItem || sourceRecord, context.opportunity?.Account?.Lista_de_Precio__r?.Tipo__c || null);
			case 'salesforce_account_id':
			case 'salesforce_opportunity_id':
			case 'salesforce_line_item_id':
			case 'salesforce_product_id':
			case 'quote_item_number':
				return rawValue || sourceRecord.Id || fallbackValue;
			default:
				if (rawValue === null || rawValue === undefined || rawValue === '') {
					return fallbackValue;
				}

				if (objectType === 'opportunity' && sapiraField === 'notes') {
					return rawValue;
				}

				return rawValue;
		}
	}

	private async resolveQuoteType(holdingId: string, salesforceType?: string | null): Promise<string> {
		if (!salesforceType) {
			return 'NewBusiness';
		}

		const mapping = await this.quoteTypeMappingRepository.findOne({
			where: {
				holding_id: holdingId,
				salesforce_type: salesforceType,
				is_active: true,
			},
		});

		return mapping?.sapira_quote_type || salesforceType || 'NewBusiness';
	}
}
