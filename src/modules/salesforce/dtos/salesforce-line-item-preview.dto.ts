import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsObject } from 'class-validator';

export class SalesforceLineItemPreviewRequestDto {
	@ApiProperty({
		description: 'Oportunidad Salesforce ya consultada por el frontend',
		type: Object,
	})
	@IsObject()
	opportunity: Record<string, unknown>;

	@ApiProperty({
		description: 'Line items Salesforce ya consultados y fusionados por el frontend',
		type: [Object],
	})
	@IsArray()
	@IsObject({ each: true })
	lineItems: Record<string, unknown>[];
}

export class SalesforceLineItemPreviewDto {
	@ApiProperty({
		description: 'Oportunidades y line items ya consultados por el frontend',
		type: [SalesforceLineItemPreviewRequestDto],
	})
	@IsArray()
	@IsObject({ each: true })
	items: SalesforceLineItemPreviewRequestDto[];
}
