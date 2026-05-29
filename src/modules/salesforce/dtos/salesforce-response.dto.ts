import { ApiProperty } from '@nestjs/swagger';

export class SalesforceConnectionResponseDto {
	@ApiProperty()
	id: string;

	@ApiProperty()
	holding_id: string;

	@ApiProperty({ required: false })
	username: string;

	@ApiProperty()
	instance_url: string;

	@ApiProperty({ enum: ['password', 'client_credentials'] })
	auth_type: string;

	@ApiProperty()
	is_active: boolean;

	@ApiProperty()
	last_sync_at: Date;

	@ApiProperty()
	created_at: Date;
}

export class SalesforceAuthResponseDto {
	@ApiProperty()
	success: boolean;

	@ApiProperty()
	message: string;

	@ApiProperty()
	instanceUrl?: string;

	@ApiProperty({ required: false })
	authMethod?: string;
}

export class SalesforceQueryResponseDto {
	@ApiProperty()
	success: boolean;

	@ApiProperty()
	data?: any;

	@ApiProperty()
	tokenRefreshed?: boolean;

	@ApiProperty()
	error?: string;

	@ApiProperty()
	errorCode?: string;
}

export class SalesforceSyncResponseDto {
	@ApiProperty()
	success: boolean;

	@ApiProperty()
	opportunities?: number;

	@ApiProperty()
	saved?: number;

	@ApiProperty()
	error?: string;
}

export class SalesforceSyncAllResponseDto {
	@ApiProperty()
	success: boolean;

	@ApiProperty()
	message: string;

	@ApiProperty()
	holdings_synced: number;

	@ApiProperty()
	total_holdings: number;

	@ApiProperty()
	total_opportunities: number;

	@ApiProperty()
	results: any[];
}

export class SalesforceTestConnectionResponseDto {
	@ApiProperty()
	ok: boolean;

	@ApiProperty()
	tested_at: string;

	@ApiProperty()
	result?: any;

	@ApiProperty()
	error?: string;
}

export class SalesforcePreviewResponseDto {
	@ApiProperty()
	connection: {
		holding_id: string;
		username: string;
		instance_url: string;
	};

	@ApiProperty()
	sync_type: string;

	@ApiProperty()
	preview: boolean;

	@ApiProperty()
	message: string;
}
