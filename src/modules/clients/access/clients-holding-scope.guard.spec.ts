import { ExecutionContext, ForbiddenException } from '@nestjs/common';

import { ClientsHoldingScopeGuard } from './clients-holding-scope.guard';
import { UserHoldingsService } from './user-holdings.service';

const contextFor = (request: Record<string, unknown>) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

describe('ClientsHoldingScopeGuard', () => {
	const access = { userHoldingIds: jest.fn().mockResolvedValue(['h-1', 'h-2']) } as unknown as UserHoldingsService;
	const guard = new ClientsHoldingScopeGuard(access);

	it('deja pasar y expone los holdings del usuario', async () => {
		const request: Record<string, unknown> = { user: { sub: 'auth-1' }, query: { holding_id: 'h-2' }, headers: {} };

		await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
		expect(request.holdingIds).toEqual(['h-1', 'h-2']);
	});

	it('rechaza un holding ajeno en query, body o header', async () => {
		for (const request of [
			{ user: { sub: 'auth-1' }, query: { holding_id: 'h-9' }, headers: {} },
			{ user: { sub: 'auth-1' }, body: { holding_id: 'h-9' }, headers: {} },
			{ user: { sub: 'auth-1' }, headers: { 'x-holding-id': 'h-9' } },
		]) {
			await expect(guard.canActivate(contextFor(request))).rejects.toBeInstanceOf(ForbiddenException);
		}
	});

	it('sin holding en la petición, pasa (las rutas por id verifican el registro)', async () => {
		await expect(guard.canActivate(contextFor({ user: { sub: 'auth-1' }, headers: {} }))).resolves.toBe(true);
	});
});
