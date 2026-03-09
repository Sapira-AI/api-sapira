import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';

export interface SupabaseUser {
	id: string;
	email?: string;
	user_metadata?: any;
	app_metadata?: any;
	aud: string;
	exp: number;
	iat: number;
	iss: string;
	sub: string;
	role?: string;
}

@Injectable()
export class SupabaseStrategy extends PassportStrategy(Strategy, 'supabase') {
	private supabase: any;

	constructor(private configService: ConfigService) {
		const jwtSecret = configService.get<string>('SUPABASE_JWT_SECRET');

		if (!jwtSecret) {
			throw new Error('SUPABASE_JWT_SECRET no está configurado en las variables de entorno');
		}

		super({
			jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
			ignoreExpiration: false,
			secretOrKey: jwtSecret,
			algorithms: ['HS256'],
		});
	}

	async validate(payload: any): Promise<SupabaseUser> {
		try {
			// Validar que el payload tenga la estructura esperada de Supabase
			if (!payload.sub || !payload.aud || payload.aud !== 'authenticated') {
				throw new UnauthorizedException('Token inválido');
			}

			// Verificar que el token no haya expirado
			const currentTime = Math.floor(Date.now() / 1000);
			if (payload.exp && payload.exp < currentTime) {
				throw new UnauthorizedException('Token expirado');
			}

			// Crear el objeto de usuario
			const user: SupabaseUser = {
				id: payload.sub,
				email: payload.email,
				user_metadata: payload.user_metadata || {},
				app_metadata: payload.app_metadata || {},
				aud: payload.aud,
				exp: payload.exp,
				iat: payload.iat,
				iss: payload.iss,
				sub: payload.sub,
				role: payload.role || 'authenticated',
			};

			return user;
		} catch (error) {
			throw new UnauthorizedException('Token de Supabase inválido');
		}
	}
}
