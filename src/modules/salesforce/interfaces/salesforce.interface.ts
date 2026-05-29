export interface SalesforceCredentials {
	username: string;
	password: string;
	securityToken: string;
	clientId: string;
	clientSecret: string;
	loginUrl?: string;
}

export interface SalesforceAuthResponse {
	access_token: string;
	refresh_token: string;
	instance_url: string;
	id: string;
	issued_at: string;
	expires_in?: number;
	signature?: string;
	token_type?: string;
}

export interface SalesforceQueryResult {
	totalSize: number;
	done: boolean;
	records: any[];
	nextRecordsUrl?: string;
}

export interface SalesforceOpportunity {
	Id: string;
	Name: string;
	AccountId: string;
	Type?: string;
	CloseDate: string;
	StageName: string;
	IsWon: boolean;
	IsClosed: boolean;
	Amount?: number;
	CurrencyIsoCode?: string;
	Modalidad_de_pago__c?: string;
	Forma_de_pago__c?: string;
	Contrato__c?: string;
	Orden_de_compra__c?: string;
	QuoteProjectManager__c?: string;
	QuoteBillingEmail__c?: string;
	id_largo_oportunidad__c?: string;
	CreatedDate?: string;
	OwnerId?: string;
	Owner?: {
		Id: string;
		Name: string;
		Email: string;
	};
	Account?: {
		Id: string;
		Name: string;
		BillingCountry?: string;
		Plazos_de_pago__c?: string;
		Lista_de_Precio__r?: { Tipo__c?: string };
	};
}

export interface SalesforceSyncResult {
	holding_id: string;
	opportunities: number;
	saved: number;
	success: boolean;
	error?: string;
}

export interface SalesforceAccount {
	Id: string;
	Name: string;
	Salesforce_API_ID__c?: string;
	Industry?: string;
	Segmento__c?: string;
	BillingCountry?: string;
	BillingStreet?: string;
	BillingCity?: string;
	BillingState?: string;
	BillingPostalCode?: string;
	DemoCountry__c?: string;
	BusinessName__c?: string;
	RUT__c?: string;
	Email_de_contacto_principal__c?: string;
	Industria_sector__c?: string;
	Plazos_de_pago__c?: string;
	Lista_de_Precio__r?: {
		Tipo__c?: string;
	};
	M_nimo_facturable_licencias__c?: number;
	Per_odo_de_facturaci_n__c?: string;
}

export interface SalesforceOpportunityLineItem {
	Id: string;
	OpportunityId: string;
	Product2Id: string;
	Product2?: {
		Id: string;
		Name: string;
		ProductCode?: string;
		Description?: string;
		Family?: string;
	};
	Quantity: number;
	UnitPrice: number;
	ListPrice?: number;
	TotalPrice: number;
	Recurrencia__c?: string;
	Fuente_de_unidad__c?: string;
	Fuente_Optimizaciones__c?: string;
	Description?: string;
}

export interface SalesforceOpportunityWithLineItems extends SalesforceOpportunity {
	OpportunityLineItems?: {
		totalSize: number;
		done: boolean;
		records: SalesforceOpportunityLineItem[];
	};
}

export interface SalesforceQuote {
	Id: string;
	OpportunityId: string;
	Name?: string;
	QuoteNumber?: string;
	Status?: string;
}

export interface SalesforceQuoteLineItem {
	Id: string;
	QuoteId: string;
	OpportunityLineItemId?: string;
	Product2Id?: string;
	Quantity?: number;
	UnitPrice?: number;
	ListPrice?: number;
	TotalPrice?: number;
	Discount?: number;
	ServiceDate?: string;
	Description?: string;
	SortOrder?: number;
	// Campos custom que SÍ existen en QuoteLineItem
	Recurrencia__c?: string;
	Fecha_de_inicio__c?: string;
	Fecha_de_Fin__c?: string;
	Calculo_para_facturaci_n__c?: string;
	Unidad_facturada__c?: string;
	Fuente_de_unidad__c?: string;
	Tipo_de_agregaci_n__c?: string;
	Fuente_Optimizaciones__c?: string;
}

export interface SalesforceProduct {
	Id: string;
	Name: string;
	ProductCode?: string;
	Description?: string;
	Family?: string;
	IsActive?: boolean;
}
