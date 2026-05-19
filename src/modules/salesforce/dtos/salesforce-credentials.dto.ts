import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUrl } from 'class-validator';

export class SalesforceCredentialsDto {
	@ApiProperty({
		description: 'Usuario de Salesforce',
		example: 'usuario@ejemplo.com',
	})
	@IsNotEmpty()
	@IsString()
	username: string;

	@ApiProperty({
		description: 'Contraseña de Salesforce',
		example: 'MyPassword123',
	})
	@IsNotEmpty()
	@IsString()
	password: string;

	@ApiProperty({
		description: 'Token de seguridad de Salesforce',
		example: 'abc123xyz456',
	})
	@IsNotEmpty()
	@IsString()
	securityToken: string;

	@ApiProperty({
		description: 'Client ID de la Connected App',
		example: '3MVG9...',
	})
	@IsNotEmpty()
	@IsString()
	clientId: string;

	@ApiProperty({
		description: 'Client Secret de la Connected App',
		example: 'ABC123...',
	})
	@IsNotEmpty()
	@IsString()
	clientSecret: string;

	@ApiProperty({
		description: 'URL de login de Salesforce',
		example: 'https://login.salesforce.com',
		required: false,
	})
	@IsOptional()
	@IsUrl()
	loginUrl?: string;
}
