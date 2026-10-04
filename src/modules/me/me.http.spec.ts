import { INestApplication, ValidationError, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { flattenValidationErrors, validationException } from '@/core/utils/validation-errors';

import { MeController } from './me.controller';
import { MeService } from './me.service';

/**
 * `/me/*` por HTTP con el `ValidationPipe` real (`whitelist` + `forbidNonWhitelisted`) y el servicio mockeado: rutas, quién llama (sesión
 * y JWT, nunca del body) y mensajes de validación en español.
 */
describe('Mi perfil · HTTP', () => {
	let app: INestApplication;
	const me = {
		getProfile: jest.fn(async () => ({ ok: true })),
		updateProfile: jest.fn(async () => ({ ok: true })),
		prepareAvatarUpload: jest.fn(async () => ({ ok: true })),
		confirmAvatar: jest.fn(async () => ({ ok: true })),
		revokeAllSessions: jest.fn(async () => ({ message: 'ok' })),
		changePassword: jest.fn(async () => ({ message: 'ok' })),
	};

	beforeAll(async () => {
		const moduleRef = await Test.createTestingModule({ controllers: [MeController], providers: [{ provide: MeService, useValue: me }] })
			.overrideGuard(SupabaseAuthGuard)
			.useValue({
				canActivate: (context: { switchToHttp: () => { getRequest: () => { user?: unknown } } }) => {
					context.switchToHttp().getRequest().user = { id: 'auth-1', sub: 'auth-1', email: 'domi@x.cl', identities: [] };

					return true;
				},
			})
			.compile();

		app = moduleRef.createNestApplication();
		app.useGlobalPipes(
			new ValidationPipe({
				whitelist: true,
				forbidNonWhitelisted: true,
				transform: true,
				exceptionFactory: (errors: ValidationError[]) => {
					throw validationException(flattenValidationErrors(errors));
				},
			})
		);
		await app.init();
	});

	afterAll(async () => {
		await app.close();
	});

	beforeEach(() => jest.clearAllMocks());

	const server = () => request(app.getHttpServer());

	it('GET /me/profile pasa la sesión (sub, correo, JWT), sin holding', async () => {
		await server().get('/me/profile').set('Authorization', 'Bearer jwt-1').set('x-holding-id', 'cualquiera').expect(200);
		expect(me.getProfile).toHaveBeenCalledWith({
			authId: 'auth-1',
			email: 'domi@x.cl',
			jwt: 'jwt-1',
			authUser: expect.objectContaining({ identities: [] }),
		});
	});

	it('PATCH /me/profile valida nombre y avatar; rechaza campos desconocidos (correo, user_id, holding_id)', async () => {
		await server()
			.patch('/me/profile')
			.send({ name: '  Domi  ', avatar: { kind: 'preset', preset_id: 'preset-12' } })
			.expect(200);
		expect(me.updateProfile).toHaveBeenCalledWith(expect.anything(), { name: 'Domi', avatar: { kind: 'preset', preset_id: 'preset-12' } });

		const bad = await server().patch('/me/profile').send({ name: 'D' }).expect(400);

		expect(bad.body.errors).toEqual([{ field: 'name', message: 'El nombre debe tener al menos 2 caracteres' }]);
		const preset = await server()
			.patch('/me/profile')
			.send({ avatar: { kind: 'preset', preset_id: 'preset-13' } })
			.expect(400);

		expect(preset.body.errors).toEqual([{ field: 'avatar.preset_id', message: 'Elige un avatar de la lista' }]);
		await server()
			.patch('/me/profile')
			.send({ avatar: { kind: 'emoji' } })
			.expect(400);
		for (const extra of [{ email: 'otro@x.cl' }, { user_id: 'x' }, { holding_id: 'x' }]) {
			await server().patch('/me/profile').send(extra).expect(400);
		}
		expect(me.updateProfile).toHaveBeenCalledTimes(1);
	});

	it('POST /me/avatar/upload-url y /confirm (200)', async () => {
		await server().post('/me/avatar/upload-url').send({ file_name: 'yo.png', mime_type: 'image/png', size: 1000 }).expect(200);
		await server().post('/me/avatar/upload-url').send({ file_name: 'yo.png', mime_type: 'image/png', size: 0 }).expect(400);
		await server().post('/me/avatar/confirm').send({ path: 'users/x/y.png' }).expect(200);
		await server().post('/me/avatar/confirm').send({}).expect(400);
	});

	it('POST /me/sessions/revoke-all usa el JWT del header', async () => {
		await server().post('/me/sessions/revoke-all').set('Authorization', 'Bearer jwt-9').expect(200);
		expect(me.revokeAllSessions).toHaveBeenCalledWith(expect.objectContaining({ jwt: 'jwt-9' }));
	});

	it('POST /me/password aplica las reglas (8+, letra y número) con mensajes en español', async () => {
		await server().post('/me/password').send({ current_password: 'vieja', new_password: 'nueva1234', sign_out_other_sessions: true }).expect(200);
		const short = await server().post('/me/password').send({ current_password: 'vieja', new_password: 'a1' }).expect(400);

		expect(short.body.errors[0]).toEqual({ field: 'new_password', message: 'La contraseña nueva debe tener al menos 8 caracteres' });
		const noDigit = await server().post('/me/password').send({ current_password: 'vieja', new_password: 'soloLetras' }).expect(400);

		expect(noDigit.body.message).toContain('al menos un número');
		const noLetter = await server().post('/me/password').send({ current_password: 'vieja', new_password: '12345678' }).expect(400);

		expect(noLetter.body.message).toContain('al menos una letra');
		await server().post('/me/password').send({ new_password: 'nueva1234' }).expect(400);
		expect(me.changePassword).toHaveBeenCalledTimes(1);
	});
});
