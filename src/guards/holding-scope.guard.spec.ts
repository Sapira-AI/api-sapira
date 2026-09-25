import { BadRequestException, ExecutionContext, ForbiddenException } from '@nestjs/common';

import { HoldingScopeGuard } from './holding-scope.guard';
import { UserHoldingsService } from './user-holdings.service';

const H1 = '11111111-1111-4111-8111-111111111111';
const H2 = '22222222-2222-4222-8222-222222222222';

const contextFor = (request: Record<string, unknown>) => ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

describe('HoldingScopeGuard', () => {
	const isActiveMember = jest.fn(async (_authId: string, holdingId: string) => holdingId === H1);
	const guard = new HoldingScopeGuard({ isActiveMember } as unknown as UserHoldingsService);

	it('deja pasar al miembro activo y expone el holding validado', async () => {
		const request: Record<string, unknown> = { user: { sub: 'auth-1' }, headers: { 'x-holding-id': H1 } };

		await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
		expect(request.holdingId).toBe(H1);
		expect(isActiveMember).toHaveBeenCalledWith('auth-1', H1);
	});

	it('sin header, o con un valor que no es UUID, responde 400', async () => {
		for (const headers of [{}, { 'x-holding-id': '' }, { 'x-holding-id': 'h-1' }]) {
			await expect(guard.canActivate(contextFor({ user: { sub: 'auth-1' }, headers }))).rejects.toBeInstanceOf(BadRequestException);
		}
	});

	it('holding al que el usuario no pertenece → 403', async () => {
		await expect(guard.canActivate(contextFor({ user: { sub: 'auth-1' }, headers: { 'x-holding-id': H2 } }))).rejects.toBeInstanceOf(
			ForbiddenException
		);
	});

	it('holding_id en query o body distinto al del header → 403', async () => {
		for (const extra of [{ query: { holding_id: H2 } }, { body: { holding_id: H2 } }]) {
			await expect(
				guard.canActivate(contextFor({ user: { sub: 'auth-1' }, headers: { 'x-holding-id': H1 }, ...extra }))
			).rejects.toBeInstanceOf(ForbiddenException);
		}
	});

	it('holding_id en query igual al del header, pasa', async () => {
		await expect(
			guard.canActivate(contextFor({ user: { sub: 'auth-1' }, headers: { 'x-holding-id': H1 }, query: { holding_id: H1 } }))
		).resolves.toBe(true);
	});

	it('sin sesión → 403', async () => {
		await expect(guard.canActivate(contextFor({ headers: { 'x-holding-id': H1 } }))).rejects.toBeInstanceOf(ForbiddenException);
	});
});
