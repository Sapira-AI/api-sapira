import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsObject } from 'class-validator';

export class SalesforceClientEntityPreviewDto {
	@ApiProperty({
		description: 'Accounts Salesforce ya consultados por el frontend',
		type: [Object],
	})
	@IsArray()
	@IsObject({ each: true })
	accounts: Record<string, unknown>[];
}
