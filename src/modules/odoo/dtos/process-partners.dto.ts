import { IsArray, IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';

export class ProcessPartnersDto {
	@IsUUID()
	@IsNotEmpty()
	holding_id: string;

	@IsString()
	@IsNotEmpty()
	mapping_id: string;

	@IsArray()
	@IsOptional()
	partner_ids?: number[];
}

export class ProcessPartnersResponseDto {
	success: boolean;
	message: string;
	results: {
		total: number;
		success: number;
		errors: number;
		details: Array<{
			odoo_id: number;
			status: 'success' | 'error';
			action?: 'create' | 'update';
			error?: string;
			staging_id?: number;
		}>;
	};
}
