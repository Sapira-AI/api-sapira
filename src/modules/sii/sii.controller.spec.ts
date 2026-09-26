import { INestApplication, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';

import { SiiController } from './sii.controller';
import { SiiService } from './sii.service';

/**
 * Los tres casos que exige la regla de tenancy (`docs/v2-rediseno/autorizacion-y-tenancy.md`):
 * sin header → 400, holding ajeno → 403, registro de otro holding → 404.
 *
 * `SupabaseAuthGuard` se sobreescribe (autenticar es problema suyo, ya probado aparte) y
 * `HoldingScopeGuard` corre de verdad, con la pertenencia mockeada en `UserHoldingsService`.
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTHER_HOLDING = '22222222-2222-4222-8222-222222222222';
const COMPANY = '5652e95e-bb99-48f5-aa1c-13c8c2638fc6';

describe('SiiController (tenancy)', () => {
	let app: INestApplication;
	const sii = {
		eligibleCompanies: jest.fn(),
		getConfiguration: jest.fn(),
		integrateWithFactura: jest.fn(),
		updateConfiguration: jest.fn(),
		uploadCertificate: jest.fn(),
		uploadCaf: jest.fn(),
		reserveFolio: jest.fn(),
	};

	beforeEach(async () => {
		jest.clearAllMocks();

		const moduleRef = await Test.createTestingModule({
			controllers: [SiiController],
			providers: [
				{ provide: SiiService, useValue: sii },
				HoldingScopeGuard,
				{ provide: UserHoldingsService, useValue: { isActiveMember: jest.fn(async (_authId: string, holdingId: string) => holdingId === HOLDING) } },
			],
		})
			.overrideGuard(SupabaseAuthGuard)
			.useValue({
				canActivate: (context: { switchToHttp: () => { getRequest: () => Record<string, unknown> } }) => {
					context.switchToHttp().getRequest().user = { sub: 'auth-1' };
					return true;
				},
			})
			.compile();

		app = moduleRef.createNestApplication();
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	it('sin header x-holding-id responde 400 y no llega al servicio', async () => {
		await request(app.getHttpServer()).get('/sii/companies').expect(400);

		expect(sii.eligibleCompanies).not.toHaveBeenCalled();
	});

	it('con un x-holding-id que no es UUID responde 400', async () => {
		await request(app.getHttpServer()).get('/sii/companies').set('x-holding-id', 'holding-1').expect(400);

		expect(sii.eligibleCompanies).not.toHaveBeenCalled();
	});

	it('con un holding al que el usuario no pertenece responde 403', async () => {
		await request(app.getHttpServer()).get('/sii/companies').set('x-holding-id', OTHER_HOLDING).expect(403);

		expect(sii.eligibleCompanies).not.toHaveBeenCalled();
	});

	it('con una razón social de otro holding responde 404', async () => {
		sii.getConfiguration.mockRejectedValue(new NotFoundException('Razón social chilena no encontrada en el holding seleccionado'));

		await request(app.getHttpServer()).get(`/sii/companies/${COMPANY}`).set('x-holding-id', HOLDING).expect(404);

		expect(sii.getConfiguration).toHaveBeenCalledWith(HOLDING, COMPANY);
	});

	it('entrega al servicio el holding validado del header, no uno de la query', async () => {
		sii.eligibleCompanies.mockResolvedValue([]);

		await request(app.getHttpServer()).get('/sii/companies').set('x-holding-id', HOLDING).expect(200);

		expect(sii.eligibleCompanies).toHaveBeenCalledWith(HOLDING);
	});

	it('rechaza con 403 si la query trae un holding_id distinto al del header', async () => {
		await request(app.getHttpServer()).get(`/sii/companies?holding_id=${OTHER_HOLDING}`).set('x-holding-id', HOLDING).expect(403);

		expect(sii.eligibleCompanies).not.toHaveBeenCalled();
	});
});
