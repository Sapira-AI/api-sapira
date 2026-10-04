import { IsBoolean, IsOptional, Matches } from 'class-validator';

/** `POST /banco-central/exchange-rates/close-month` (super admin): cierre mensual de la moneda de compañía a mano. */
export class CloseFxMonthDto {
	/** Mes a cerrar `AAAA-MM` (default: el que terminó). */
	@IsOptional()
	@Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Usa el formato AAAA-MM' })
	month?: string;

	/** Cierra los promedios aunque sus tasas diarias estén incompletas. */
	@IsOptional()
	@IsBoolean()
	force?: boolean;
}
