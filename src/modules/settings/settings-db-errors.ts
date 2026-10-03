import {
	BadRequestException,
	CallHandler,
	ConflictException,
	ExecutionContext,
	HttpException,
	Injectable,
	Logger,
	NestInterceptor,
} from '@nestjs/common';
import { catchError, Observable, throwError } from 'rxjs';

/**
 * "Nunca 500 sin mensaje" (decisión de Domi 03-10): toda excepción **esperable** de Postgres que llegue desde Configuración o Productos
 * se traduce a un 4xx con `message` corto en español. Los servicios validan antes con mensajes propios; esto cubre lo que se escapa
 * (carreras entre dos pestañas, constraints y triggers que son invariantes). Lo inesperado sigue como 500 (y se registra).
 */

type PgError = { code?: string; constraint?: string; message?: string; driverError?: { code?: string; constraint?: string; message?: string } };

/** Mensajes por constraint conocida (más precisos que el genérico de cada código). */
const CONSTRAINT_MESSAGES: Record<string, string> = {
	holding_fx_period_rates_unique_period: 'Ya existe una tasa para ese par en esas fechas',
	holding_fx_period_rates_rate_check: 'La tasa debe ser mayor que cero',
	holding_fx_period_rates_period_check: 'La fecha de fin debe ser igual o posterior a la de inicio',
	holding_settings_auto_renewal_notice_days_check: 'Los días de aviso deben estar entre 1 y 180',
	holding_settings_fx_system_policy_check: 'La política de tipo de cambio debe ser tasa fija por período o promedio mensual',
	company_legal_documents_pkey: 'Este documento ya está registrado',
	products_status_check: 'El estado del producto debe ser activo o archivado',
	custom_field_definitions_field_type_check: 'El tipo de campo debe ser texto, número, lista, sí/no o fecha',
	custom_field_definitions_options_check: 'Las opciones son obligatorias para un campo de lista y solo existen en ese tipo',
};

const FX_OVERLAP = 'Ya existe una tasa para ese par en esas fechas';
const CONCURRENT = 'Otra persona modificó estos datos al mismo tiempo: vuelve a intentarlo';

const pgFields = (error: unknown) => {
	const raw = (error ?? {}) as PgError;

	return {
		code: raw.code ?? raw.driverError?.code,
		constraint: raw.constraint ?? raw.driverError?.constraint,
		message: String(raw.driverError?.message ?? raw.message ?? ''),
	};
};

/** HttpException equivalente a un error de Postgres esperable, o `null` si no lo es (queda como 500). */
export function translateDbError(error: unknown): HttpException | null {
	if (error instanceof HttpException) return null;
	const { code, constraint, message } = pgFields(error);

	if (!code) return null;
	const known = constraint ? CONSTRAINT_MESSAGES[constraint] : undefined;

	switch (code) {
		case '23505': // unique_violation
			return new ConflictException(known ?? 'Ya existe un registro con esos datos');
		case '23503': // foreign_key_violation
			return /still referenced|todavía/i.test(message)
				? new ConflictException('Está en uso en otros registros: no se puede eliminar')
				: new BadRequestException('Un dato relacionado no existe o ya se eliminó');
		case '23514': // check_violation
			return new BadRequestException(known ?? 'Un valor no cumple las reglas permitidas');
		case '23502': // not_null_violation
			return new BadRequestException('Falta un dato obligatorio');
		case '22007': // invalid_datetime_format
		case '22008': // datetime_field_overflow (2026-02-30)
			return new BadRequestException('La fecha no es válida');
		case '22P02': // invalid_text_representation
			return new BadRequestException('Un dato tiene un formato no válido');
		case '22003': // numeric_value_out_of_range
			return new BadRequestException('Un número está fuera del rango permitido');
		case '22001': // string_data_right_truncation
			return new BadRequestException('Un texto supera el largo permitido');
		case '40001': // serialization_failure
		case '40P01': // deadlock_detected
		case '55P03': // lock_not_available
			return new ConflictException(CONCURRENT);
		case 'P0001': {
			// RAISE EXCEPTION de un trigger (invariantes en español: tasas, período cerrado, compañía↔holding).
			if (/superpo|se cruza|overlap/i.test(message)) return new ConflictException(FX_OVERLAP);
			const text = message.trim();

			return new ConflictException(text && text.length <= 300 ? text : 'La operación no cumple una regla de la base de datos');
		}
		default:
			return null;
	}
}

/** Interceptor de los controladores de Configuración y Productos: aplica `translateDbError`. */
@Injectable()
export class SettingsDbErrorsInterceptor implements NestInterceptor {
	private readonly logger = new Logger('SettingsDbErrors');

	intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
		return next.handle().pipe(
			catchError((error: unknown) => {
				const translated = translateDbError(error);

				if (translated) this.logger.warn(`Error de base traducido a ${translated.getStatus()}: ${pgFields(error).message}`);

				return throwError(() => translated ?? error);
			})
		);
	}
}
