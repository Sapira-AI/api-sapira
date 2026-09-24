import { createParamDecorator, ExecutionContext, InternalServerErrorException } from '@nestjs/common';

/** Holding activo validado por `HoldingScopeGuard`. Usarlo sin el guard es un error de programación. */
export const HoldingId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
	const holdingId: string | undefined = ctx.switchToHttp().getRequest().holdingId;

	if (!holdingId) throw new InternalServerErrorException('HoldingId requiere HoldingScopeGuard en el controlador');

	return holdingId;
});
