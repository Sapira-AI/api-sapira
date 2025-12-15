import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class SupabaseAuthGuard extends AuthGuard('supabase') {
	canActivate(context: ExecutionContext) {
		return super.canActivate(context);
	}
}
