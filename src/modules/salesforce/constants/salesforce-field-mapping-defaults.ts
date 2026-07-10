import { SalesforceFieldMappingObjectType } from '../entities/salesforce-field-mapping.entity';

export interface SalesforceFieldMappingDefault {
	object_type: SalesforceFieldMappingObjectType;
	sapira_field: string;
	salesforce_field: string;
	is_required: boolean;
	data_type?: string;
	default_value?: string | null;
}

export const SALESFORCE_FIELD_MAPPING_DEFAULTS: Record<SalesforceFieldMappingObjectType, SalesforceFieldMappingDefault[]> = {
	client: [
		{ object_type: 'client', sapira_field: 'client_number', salesforce_field: 'Salesforce_API_ID__c', is_required: true, data_type: 'text' },
		{ object_type: 'client', sapira_field: 'name_commercial', salesforce_field: 'Name', is_required: true, data_type: 'text' },
		{ object_type: 'client', sapira_field: 'industry', salesforce_field: 'Industry', is_required: false, data_type: 'text' },
		{ object_type: 'client', sapira_field: 'segment', salesforce_field: 'Segmento__c', is_required: false, data_type: 'text' },
		{ object_type: 'client', sapira_field: 'country', salesforce_field: 'DemoCountry__c', is_required: false, data_type: 'text' },
		{ object_type: 'client', sapira_field: 'salesforce_account_id', salesforce_field: 'Id', is_required: true, data_type: 'text' },
	],
	client_entity: [
		{ object_type: 'client_entity', sapira_field: 'legal_name', salesforce_field: 'BusinessName__c', is_required: false, data_type: 'text' },
		{ object_type: 'client_entity', sapira_field: 'tax_id', salesforce_field: 'RUT__c', is_required: false, data_type: 'text' },
		{
			object_type: 'client_entity',
			sapira_field: 'legal_address',
			salesforce_field: 'BillingStreet,BillingCity,BillingState,BillingPostalCode,BillingCountry',
			is_required: false,
			data_type: 'text',
		},
		{ object_type: 'client_entity', sapira_field: 'country', salesforce_field: 'DemoCountry__c', is_required: false, data_type: 'text' },
		{ object_type: 'client_entity', sapira_field: 'economic_activity', salesforce_field: 'Industria_sector__c', is_required: false, data_type: 'text' },
		{ object_type: 'client_entity', sapira_field: 'client_number', salesforce_field: 'Salesforce_API_ID__c', is_required: false, data_type: 'text' },
	],
	opportunity: [
		{ object_type: 'opportunity', sapira_field: 'quote_number', salesforce_field: 'id_largo_oportunidad__c', is_required: false, data_type: 'text' },
		{ object_type: 'opportunity', sapira_field: 'quote_date', salesforce_field: 'CreatedDate', is_required: false, data_type: 'date' },
		{ object_type: 'opportunity', sapira_field: 'booking_date', salesforce_field: 'CloseDate', is_required: false, data_type: 'date' },
		{ object_type: 'opportunity', sapira_field: 'quote_type', salesforce_field: 'Type', is_required: false, data_type: 'text', default_value: 'NewBusiness' },
		{ object_type: 'opportunity', sapira_field: 'payment_terms', salesforce_field: 'Account.Plazos_de_pago__c', is_required: false, data_type: 'text' },
		{ object_type: 'opportunity', sapira_field: 'requires_contract_document', salesforce_field: 'Contrato__c', is_required: false, data_type: 'boolean' },
		{
			object_type: 'opportunity',
			sapira_field: 'requires_references_for_billing',
			salesforce_field: 'Orden_de_compra__c',
			is_required: false,
			data_type: 'boolean',
		},
		{ object_type: 'opportunity', sapira_field: 'currency', salesforce_field: 'CurrencyIsoCode', is_required: false, data_type: 'text', default_value: 'USD' },
		{ object_type: 'opportunity', sapira_field: 'total_amount', salesforce_field: 'Amount', is_required: false, data_type: 'numeric', default_value: '0' },
		{ object_type: 'opportunity', sapira_field: 'salesforce_opportunity_id', salesforce_field: 'Id', is_required: true, data_type: 'text' },
		{ object_type: 'opportunity', sapira_field: 'notes', salesforce_field: 'Description', is_required: false, data_type: 'text' },
	],
	line_item: [
		{ object_type: 'line_item', sapira_field: 'quote_item_number', salesforce_field: 'Id', is_required: true, data_type: 'text' },
		{ object_type: 'line_item', sapira_field: 'salesforce_line_item_id', salesforce_field: 'Id', is_required: true, data_type: 'text' },
		{ object_type: 'line_item', sapira_field: 'salesforce_product_id', salesforce_field: 'Product2Id', is_required: false, data_type: 'text' },
		{ object_type: 'line_item', sapira_field: 'product_name', salesforce_field: 'Product2.Name', is_required: true, data_type: 'text' },
		{ object_type: 'line_item', sapira_field: 'item_type', salesforce_field: 'Calculo_para_facturaci_n__c', is_required: false, data_type: 'text' },
		{ object_type: 'line_item', sapira_field: 'unit_of_measure', salesforce_field: 'Unidad_facturada__c', is_required: false, data_type: 'text' },
		{ object_type: 'line_item', sapira_field: 'unit_price', salesforce_field: 'UnitPrice', is_required: false, data_type: 'numeric' },
		{ object_type: 'line_item', sapira_field: 'quantity', salesforce_field: 'Quantity', is_required: false, data_type: 'numeric', default_value: '1' },
		{ object_type: 'line_item', sapira_field: 'start_date', salesforce_field: 'Fecha_de_inicio__c', is_required: false, data_type: 'date' },
		{ object_type: 'line_item', sapira_field: 'end_date', salesforce_field: 'Fecha_de_Fin__c', is_required: false, data_type: 'date' },
		{ object_type: 'line_item', sapira_field: 'is_recurring', salesforce_field: 'Recurrencia__c', is_required: false, data_type: 'boolean' },
		{ object_type: 'line_item', sapira_field: 'custom_fields', salesforce_field: 'custom_fields', is_required: false, data_type: 'jsonb' },
	],
	product: [
		{ object_type: 'product', sapira_field: 'product_code', salesforce_field: 'ProductCode', is_required: false, data_type: 'text' },
		{ object_type: 'product', sapira_field: 'salesforce_product_id', salesforce_field: 'Id', is_required: true, data_type: 'text' },
		{ object_type: 'product', sapira_field: 'name', salesforce_field: 'Name', is_required: true, data_type: 'text' },
		{ object_type: 'product', sapira_field: 'description', salesforce_field: 'Description', is_required: false, data_type: 'text' },
		{ object_type: 'product', sapira_field: 'category', salesforce_field: 'Family', is_required: false, data_type: 'text' },
	],
	contact: [
		{ object_type: 'contact', sapira_field: 'email', salesforce_field: 'Email', is_required: true, data_type: 'text' },
		{ object_type: 'contact', sapira_field: 'phone', salesforce_field: 'Phone', is_required: false, data_type: 'text' },
	],
};

export const SALESFORCE_FIELD_MAPPING_OBJECT_TYPES: SalesforceFieldMappingObjectType[] = ['client', 'client_entity', 'opportunity', 'line_item', 'product', 'contact'];
