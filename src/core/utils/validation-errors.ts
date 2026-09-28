import { BadRequestException, HttpException, type ValidationError } from '@nestjs/common';

export interface FieldError {
	/** Ruta del campo con puntos (`items.0.product_id`). */
	field: string;
	message: string;
}

/**
 * Aplana los errores de class-validator (incluidos los de objetos y arreglos anidados) en `[{ field, message }]`,
 * con el primer mensaje de cada campo. Antes, un error anidado llegaba como "Error de validación" sin decir cuál.
 */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
	return errors.flatMap((error) => {
		const field = parent ? `${parent}.${error.property}` : error.property;
		const own = error.constraints ? [{ field, message: Object.values(error.constraints)[0] }] : [];

		return [...own, ...flattenValidationErrors(error.children ?? [], field)];
	});
}

/**
 * 400 con `message` (los mensajes unidos por coma, como antes) y `errors[{ field, message }]`.
 * `GlobalExceptionFilter` reenvía `errors` al cliente.
 */
export function validationException(errors: FieldError[]): BadRequestException {
	return new BadRequestException({ message: errors.map((error) => error.message).join(', ') || 'Error de validación', errors });
}

/** Errores por campo que traiga una HttpException (`{ message, errors: [{ field, message }] }`), o null. */
export function fieldErrorsOf(exception: unknown): FieldError[] | null {
	if (!(exception instanceof HttpException)) return null;
	const body = exception.getResponse() as { errors?: unknown } | string;

	if (typeof body !== 'object' || !Array.isArray(body?.errors)) return null;

	return body.errors
		.filter((error): error is { field: unknown; message: unknown } => Boolean(error) && typeof error === 'object')
		.map((error) => ({ field: String(error.field ?? ''), message: String(error.message ?? '') }));
}
