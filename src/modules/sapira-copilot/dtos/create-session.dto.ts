import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class CreateSessionDto {
	@ApiProperty({ description: 'Nombre de la sesión' })
	@IsString()
	@IsNotEmpty()
	name: string;

	@ApiPropertyOptional({ description: 'Descripción de la sesión' })
	@IsString()
	@IsOptional()
	description?: string;

	/** Compatibilidad con el front viejo: el holding sale de `HoldingScopeGuard` y el servicio lo ignora. */
	@ApiPropertyOptional({ deprecated: true, description: 'Compatibilidad: debe coincidir con x-holding-id; se ignora' })
	@IsString()
	@IsOptional()
	holding_id?: string;
}

export class UpdateSessionDto {
	@ApiPropertyOptional({ description: 'Nombre de la sesión' })
	@IsString()
	@IsOptional()
	name?: string;

	@ApiPropertyOptional({ description: 'Descripción de la sesión' })
	@IsString()
	@IsOptional()
	description?: string;

	/** Compatibilidad con el front viejo: el holding sale de `HoldingScopeGuard` y el servicio lo ignora. */
	@ApiPropertyOptional({ deprecated: true, description: 'Compatibilidad: debe coincidir con x-holding-id; se ignora' })
	@IsString()
	@IsOptional()
	holding_id?: string;
}
