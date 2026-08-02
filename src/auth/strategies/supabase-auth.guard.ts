import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

import { IS_PUBLIC_KEY } from '@/decorators/public.decorator';

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
	private readonly supabase: SupabaseClient;

	constructor(
		private readonly reflector: Reflector,
		configService: ConfigService
	) {
		const supabaseUrl = configService.get<string>('SUPABASE_URL');
		const supabaseKey = configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') || configService.get<string>('SUPABASE_ANON_KEY');
		if (!supabaseUrl || !supabaseKey) {
			throw new Error('SUPABASE_URL y SUPABASE_ANON_KEY (o SUPABASE_SERVICE_ROLE_KEY) son requeridos');
		}

		this.supabase = createClient(supabaseUrl, supabaseKey, {
			auth: { autoRefreshToken: false, persistSession: false },
		});
	}

	async canActivate(context: ExecutionContext): Promise<boolean> {
		const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
		if (isPublic) {
			return true;
		}

		const request = context.switchToHttp().getRequest();
		const authorization = request.headers.authorization;
		const accessToken = authorization?.startsWith('Bearer ') ? authorization.slice('Bearer '.length) : undefined;
		if (!accessToken) {
			throw new UnauthorizedException('Token de acceso requerido');
		}

		const { data, error } = await this.supabase.auth.getUser(accessToken);
		if (error || !data.user) {
			throw new UnauthorizedException('Token de Supabase inválido o expirado');
		}

		request.user = {
			...data.user,
			sub: data.user.id,
			role: data.user.role || 'authenticated',
		};
		return true;
	}
}
