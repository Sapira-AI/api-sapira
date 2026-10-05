import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** `POST /contracts/:id/renewal-proposals/:eventId/dismiss` (spec modificaciones §9.3.5): omitir la propuesta con motivo. */
export class DismissRenewalProposalDto {
	@ApiProperty({ description: 'Por qué no se renueva (queda en el evento RENEWAL_PROPOSAL_DISMISSED)' })
	@Transform(trim)
	@IsString({ message: 'Escribe el motivo' })
	@MinLength(1, { message: 'Escribe el motivo' })
	@MaxLength(500)
	reason!: string;
}
