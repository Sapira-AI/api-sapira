import { createParamDecorator, ExecutionContext } from '@nestjs/common';

import { SupabaseUser } from '../auth/strategies/supabase.strategy';

export const GetSupabaseUser = createParamDecorator((data: unknown, ctx: ExecutionContext): SupabaseUser => {
	const request = ctx.switchToHttp().getRequest();
	return request.user;
});
