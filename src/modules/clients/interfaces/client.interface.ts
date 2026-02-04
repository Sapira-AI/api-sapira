export interface IClient {
	id: string;
	holding_id?: string;
	name_commercial?: string;
	segment?: string;
	industry?: string;
	market?: string;
	status?: string;
	portal_enabled?: boolean;
	client_since?: Date;
	notes?: string;
	created_at?: Date;
	country?: string;
	client_number?: string;
	custom_fields?: Record<string, any>;
	salesforce_account_id?: string;
}

export interface IClientEntity {
	id: string;
	client_id?: string;
	legal_name?: string;
	tax_id?: string;
	country?: string;
	legal_address?: string;
	email?: string;
	phone?: string;
	holding_id: string;
	economic_activity?: string;
	client_number?: string;
	odoo_partner_id?: number;
}

export interface IClientEntityClient {
	id: string;
	client_entity_id: string;
	client_id: string;
	holding_id: string;
	is_primary: boolean;
	created_at: Date;
	created_by?: string;
}

export interface IClientWithEntities extends IClient {
	entities?: IClientEntity[];
	primary_entity?: IClientEntity;
}

export interface IPaginatedClients {
	data: IClient[];
	items: number;
	pages: number;
	currentPage: number;
	limit: number;
}
