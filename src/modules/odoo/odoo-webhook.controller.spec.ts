import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { SupabaseAuthGuard } from '@/auth/strategies/supabase-auth.guard';
import { HoldingScopeGuard } from '@/guards/holding-scope.guard';
import { UserHoldingsService } from '@/guards/user-holdings.service';

import { OdooWebhookController } from './odoo-webhook.controller';
import { OdooWebhookService } from './odoo-webhook.service';
import { OdooInvoiceBackfillService } from './services/odoo-invoice-backfill.service';

/**
 * `GET /odoo/webhooks/diagnostico` es el único endpoint del controlador acotado por holding, y el
 * guard va en el método a propósito: `POST /odoo/webhooks` lo llama Odoo sin credenciales y
 * `GET /odoo/webhooks` lo usa el front viejo sin el header. Las tres cosas se prueban juntas porque
 * el riesgo real es que agregar el guard al controlador deje a Odoo afuera.
 *
 * El tercer caso obligatorio de tenancy —registro de otro holding → 404— no aplica: el reporte no
 * se pide por id, se calcula sobre el holding activo.
 */
const HOLDING = '11111111-1111-4111-8111-111111111111';
const OTRO_HOLDING = '22222222-2222-4222-8222-222222222222';

describe('OdooWebhookController', () => {
	let app: INestApplication;
	const webhooks = {
		saveWebhookLog: jest.fn().mockResolvedValue({ _id: 'log-1' }),
		processInvoiceStatusUpdate: jest.fn().mockResolvedValue({ updated: false }),
		getWebhookLogs: jest.fn().mockResolvedValue([]),
		getReturnLegDiagnostics: jest.fn().mockResolvedValue({ veredicto: 'ok' }),
	};
	const backfill = { backfillFolios: jest.fn().mockResolvedValue({ aplicado: false, candidatas: 0 }) };

	beforeEach(async () => {
		jest.clearAllMocks();

		const moduleRef = await Test.createTestingModule({
			controllers: [OdooWebhookController],
			providers: [
				{ provide: OdooWebhookService, useValue: webhooks },
				{ provide: OdooInvoiceBackfillService, useValue: backfill },
				HoldingScopeGuard,
				{
					provide: UserHoldingsService,
					useValue: { isActiveMember: jest.fn(async (_authId: string, holdingId: string) => holdingId === HOLDING) },
				},
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
		// Mismas opciones que `main.ts`: sin esto el DTO no se valida y la prueba del alcance no prueba nada.
		app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
		await app.init();
	});

	afterEach(async () => {
		await app.close();
	});

	describe('GET /odoo/webhooks/diagnostico', () => {
		it('sin header x-holding-id responde 400 y no llega al servicio', async () => {
			await request(app.getHttpServer()).get('/odoo/webhooks/diagnostico').expect(400);

			expect(webhooks.getReturnLegDiagnostics).not.toHaveBeenCalled();
		});

		it('con un holding al que el usuario no pertenece responde 403', async () => {
			await request(app.getHttpServer()).get('/odoo/webhooks/diagnostico').set('x-holding-id', OTRO_HOLDING).expect(403);

			expect(webhooks.getReturnLegDiagnostics).not.toHaveBeenCalled();
		});

		it('con el holding activo devuelve el reporte acotado a ese holding', async () => {
			const respuesta = await request(app.getHttpServer()).get('/odoo/webhooks/diagnostico').set('x-holding-id', HOLDING).expect(200);

			expect(respuesta.body).toEqual({ veredicto: 'ok' });
			expect(webhooks.getReturnLegDiagnostics).toHaveBeenCalledWith({ dias: undefined, holdingId: HOLDING });
		});

		it('pasa la ventana en días como número', async () => {
			await request(app.getHttpServer()).get('/odoo/webhooks/diagnostico?dias=7').set('x-holding-id', HOLDING).expect(200);

			expect(webhooks.getReturnLegDiagnostics).toHaveBeenCalledWith({ dias: 7, holdingId: HOLDING });
		});
	});

	describe('POST /odoo/webhooks/backfill', () => {
		it('sin header x-holding-id responde 400 y no llega al servicio', async () => {
			await request(app.getHttpServer()).post('/odoo/webhooks/backfill').send({}).expect(400);

			expect(backfill.backfillFolios).not.toHaveBeenCalled();
		});

		it('con un holding al que el usuario no pertenece responde 403', async () => {
			await request(app.getHttpServer()).post('/odoo/webhooks/backfill').set('x-holding-id', OTRO_HOLDING).send({}).expect(403);

			expect(backfill.backfillFolios).not.toHaveBeenCalled();
		});

		it('sin cuerpo corre en seco sobre el holding activo', async () => {
			await request(app.getHttpServer()).post('/odoo/webhooks/backfill').set('x-holding-id', HOLDING).expect(201);

			expect(backfill.backfillFolios).toHaveBeenCalledWith(HOLDING, {
				dias: undefined,
				aplicar: undefined,
				odooInvoiceIds: undefined,
				campos: undefined,
				estados: undefined,
			});
		});

		it('pasa dias, aplicar, la lista de ids, el alcance y los estados', async () => {
			await request(app.getHttpServer())
				.post('/odoo/webhooks/backfill')
				.set('x-holding-id', HOLDING)
				.send({ dias: 30, aplicar: true, odoo_invoice_ids: [199014, 199077], campos: ['folio'], estados: ['Emitida'] })
				.expect(201);

			expect(backfill.backfillFolios).toHaveBeenCalledWith(HOLDING, {
				dias: 30,
				aplicar: true,
				odooInvoiceIds: [199014, 199077],
				campos: ['folio'],
				estados: ['Emitida'],
			});
		});

		it('rechaza un campo que no existe en el alcance', async () => {
			await request(app.getHttpServer())
				.post('/odoo/webhooks/backfill')
				.set('x-holding-id', HOLDING)
				.send({ campos: ['todo'] })
				.expect(400);

			expect(backfill.backfillFolios).not.toHaveBeenCalled();
		});
	});

	describe('el guard del diagnóstico no alcanza a los demás endpoints', () => {
		it('POST /odoo/webhooks sigue siendo público y sin header', async () => {
			await request(app.getHttpServer()).post('/odoo/webhooks').send({ model: 'account.move', action: 'write', id: 198707 }).expect(201);

			expect(webhooks.saveWebhookLog).toHaveBeenCalled();
			expect(webhooks.processInvoiceStatusUpdate).toHaveBeenCalled();
		});

		it('GET /odoo/webhooks sigue respondiendo sin header x-holding-id', async () => {
			await request(app.getHttpServer()).get('/odoo/webhooks').expect(200);

			expect(webhooks.getWebhookLogs).toHaveBeenCalled();
		});
	});
});
