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
	Account?: {
		Id: string;
		Name: string;
		BillingCountry?: string;
	};
}

export interface SalesforceSyncResult {
	holding_id: string;
	opportunities: number;
	saved: number;
	success: boolean;
	error?: string;
}
