import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { OdooConnectionError, OdooPartnersService } from '@/modules/odoo/odoo-partners.service';

import { ClientEntityErpService, looksLikeTaxId } from './client-entity-erp.service';

import type { ClientDirectoryService } from './client-directory.service';

const ENTITY = { id: 'e-1', legal_name: 'Tompetrol SpA', tax_id: '76.397.190-2', odoo_partner_id: null };
const candidate = (id: number, match: 'tax_id' | 'name' | null, name = 'Tompetrol SpA') => ({
	odoo_partner_id: id,
	name,
	tax_id: '76397190-2',
	country: 'Chile',
	is_company: true,
	parent_name: null,
	match,
});

describe('ClientEntityErpService', () => {
	const build = ({ entity = ENTITY as Record<string, unknown> | null, linked = [] as Record<string, unknown>[] } = {}) => {
		const query = jest.fn(async (sql: string) => {
			if (sql.startsWith('SELECT id, legal_name, tax_id, odoo_partner_id')) return entity ? [entity] : [];
			if (sql.includes('odoo_partner_id = ANY')) return linked;

			return [];
		});
		const runnerQuery = jest.fn(async () => []);
		const runner = {
			connect: jest.fn(),
			startTransaction: jest.fn(),
			commitTransaction: jest.fn(),
			rollbackTransaction: jest.fn(),
			release: jest.fn(),
			query: runnerQuery,
		};
		const odoo = { findPartnerCandidates: jest.fn(), findActivePartner: jest.fn(), connectionStatus: jest.fn() };
		const directory = { createEntity: jest.fn(async () => ({ id: 'e-new', odoo_partner_id: 200 })) };
		const service = new ClientEntityErpService(
			{ query, createQueryRunner: () => runner } as unknown as DataSource,
			odoo as unknown as OdooPartnersService,
			directory as unknown as ClientDirectoryService
		);

		return { service, query, runnerQuery, odoo, directory };
	};

	it('looksLikeTaxId: 5 dígitos o más es RUT; un nombre con un número no', () => {
		expect(looksLikeTaxId('76.397.190-2')).toBe(true);
		expect(looksLikeTaxId('TVE060408JL4')).toBe(true);
		expect(looksLikeTaxId('3M Chile')).toBe(false);
	});

	it('buscar: por el RUT de la razón social y marca los candidatos que ya usa otra razón social', async () => {
		const { service, odoo } = build({ linked: [{ id: 'e-9', legal_name: 'Tompetrol (duplicada)', odoo_partner_id: 201 }] });

		odoo.findPartnerCandidates.mockResolvedValue([candidate(200, 'tax_id'), candidate(201, 'tax_id')]);

		const result = await service.search('h-1', 'e-1');

		expect(odoo.findPartnerCandidates).toHaveBeenCalledWith('h-1', { taxId: '76.397.190-2', name: null });
		expect(result.searched).toEqual({ tax_id: '76.397.190-2', name: null });
		expect(result.candidates).toEqual([
			expect.objectContaining({ odoo_partner_id: 200, match: 'tax_id', linked_entity: null }),
			expect.objectContaining({ odoo_partner_id: 201, linked_entity: { id: 'e-9', legal_name: 'Tompetrol (duplicada)', client_name: null } }),
		]);
		expect(result.blockers).toEqual([]);
	});

	it('buscar: sin resultados por RUT, cae a la búsqueda por nombre', async () => {
		const { service, odoo } = build();

		odoo.findPartnerCandidates.mockResolvedValueOnce([]).mockResolvedValueOnce([candidate(300, 'name')]);

		const result = await service.search('h-1', 'e-1');

		expect(odoo.findPartnerCandidates).toHaveBeenLastCalledWith('h-1', { name: 'Tompetrol SpA' });
		expect(result.searched).toEqual({ tax_id: '76.397.190-2', name: 'Tompetrol SpA' });
		expect(result.candidates[0]).toMatchObject({ odoo_partner_id: 300, match: 'name' });
	});

	it('buscar a mano: un texto con letras busca por nombre', async () => {
		const { service, odoo } = build();

		odoo.findPartnerCandidates.mockResolvedValue([]);
		await service.search('h-1', 'e-1', 'Tompetrol');

		expect(odoo.findPartnerCandidates).toHaveBeenCalledTimes(1);
		expect(odoo.findPartnerCandidates).toHaveBeenCalledWith('h-1', { taxId: null, name: 'Tompetrol' });
	});

	it('buscar: sin conexión Odoo responde 200 con el bloqueo explicativo', async () => {
		const { service, odoo } = build();

		odoo.findPartnerCandidates.mockRejectedValue(new OdooConnectionError('no_connection', 'sin conexión'));

		const result = await service.search('h-1', 'e-1');

		expect(result.candidates).toEqual([]);
		expect(result.blockers[0]).toMatchObject({ code: 'odoo_not_connected' });
		expect(result.blockers[0].next_step).toBeTruthy();
	});

	it('vincular: 409 partner_already_linked diciendo cuál razón social lo usa (sin consultar Odoo ni escribir)', async () => {
		const { service, odoo, runnerQuery } = build({ linked: [{ id: 'e-9', legal_name: 'Otra SpA', odoo_partner_id: 200 }] });

		const error = await service.link('h-1', 'e-1', 200).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(ConflictException);
		expect((error as ConflictException).message).toContain('Otra SpA');
		expect((error as { code?: string }).code).toBe('partner_already_linked');
		expect(odoo.findActivePartner).not.toHaveBeenCalled();
		expect(runnerQuery).not.toHaveBeenCalled();
	});

	it('vincular: 404 si el partner no existe o está archivado en Odoo', async () => {
		const { service, odoo } = build();

		odoo.findActivePartner.mockResolvedValue(null);

		await expect(service.link('h-1', 'e-1', 999)).rejects.toBeInstanceOf(NotFoundException);
	});

	it('vincular: 503 explicativo si Odoo no responde', async () => {
		const { service, odoo } = build();

		odoo.findActivePartner.mockRejectedValue(new Error('ETIMEDOUT'));

		await expect(service.link('h-1', 'e-1', 200)).rejects.toBeInstanceOf(ServiceUnavailableException);
	});

	it('vincular: escribe odoo_partner_id con la marca de la API primero', async () => {
		const { service, odoo, runnerQuery } = build();

		odoo.findActivePartner.mockResolvedValue(candidate(200, null));

		const result = await service.link('h-1', 'e-1', 200);

		expect(result).toMatchObject({ client_entity_id: 'e-1', previous_odoo_partner_id: null, partner: { odoo_partner_id: 200 } });
		const calls = runnerQuery.mock.calls as unknown as Array<[string, unknown[]]>;

		expect(calls[0][0]).toContain("set_config('sapira.writer', 'api', true)");
		expect(calls[1]).toEqual(['UPDATE client_entities SET odoo_partner_id = $3 WHERE id = $1 AND holding_id = $2', ['e-1', 'h-1', 200]]);
	});

	it('desvincular: deja odoo_partner_id en NULL; 404 si la razón social no es del holding', async () => {
		const linked = build({ entity: { ...ENTITY, odoo_partner_id: 200 } });
		const result = await linked.service.unlink('h-1', 'e-1');

		expect(result.previous_odoo_partner_id).toBe(200);
		expect((linked.runnerQuery.mock.calls as unknown as Array<[string]>)[1][0]).toContain('SET odoo_partner_id = NULL');

		await expect(build({ entity: null }).service.unlink('h-1', 'e-x')).rejects.toBeInstanceOf(NotFoundException);
	});

	describe('Traer desde ERP', () => {
		const data = { client_id: 'c-1', legal_name: 'Tompetrol SpA', tax_id: '76.397.190-2', country: 'Chile', email: 'pagos@tompetrol.cl' };

		it('conexión: solo lee la configuración del holding (no llama al ERP)', async () => {
			const { service, odoo } = build();

			odoo.connectionStatus.mockResolvedValue({ connected: false, name: null });

			expect(await service.connection('h-1')).toEqual({ connected: false, name: null });
			expect(odoo.findPartnerCandidates).not.toHaveBeenCalled();
		});

		it('buscar sin razón social: por RUT o por nombre, marcando el partner ya vinculado con su razón social y cliente', async () => {
			const { service, odoo, query } = build({
				linked: [{ id: 'e-9', legal_name: 'Otra SpA', odoo_partner_id: 201, client_name: 'Grupo Otro' }],
			});

			odoo.findPartnerCandidates.mockResolvedValue([candidate(200, 'tax_id'), candidate(201, 'tax_id')]);
			const byTax = await service.searchForNew('h-1', ' 76.397.190-2 ');

			expect(odoo.findPartnerCandidates).toHaveBeenCalledWith('h-1', { taxId: '76.397.190-2', name: null });
			expect(byTax.candidates[0].linked_entity).toBeNull();
			expect(byTax.candidates[1].linked_entity).toEqual({ id: 'e-9', legal_name: 'Otra SpA', client_name: 'Grupo Otro' });
			// Sin razón social propia que excluir.
			expect((query.mock.calls as unknown as Array<[string, unknown[]]>).find(([sql]) => sql.includes('= ANY'))?.[1][2]).toBeNull();

			await service.searchForNew('h-1', 'Tompetrol');
			expect(odoo.findPartnerCandidates).toHaveBeenLastCalledWith('h-1', { taxId: null, name: 'Tompetrol' });
		});

		it('buscar sin conexión: 200 con el bloqueo en palabras claras', async () => {
			const { service, odoo } = build();

			odoo.findPartnerCandidates.mockRejectedValue(new OdooConnectionError('no_connection', 'sin conexión'));
			const result = await service.searchForNew('h-1', 'Tompetrol');

			expect(result.candidates).toEqual([]);
			expect(result.blockers[0]).toMatchObject({ code: 'odoo_not_connected', message: expect.stringContaining('ERP') });
		});

		it('crear + vincular: valida el partner y crea en una sola operación con odooPartnerId', async () => {
			const { service, odoo, directory } = build();

			odoo.findActivePartner.mockResolvedValue(candidate(200, null));
			const row = await service.createWithPartner('h-1', data, 200, false);

			expect(odoo.findActivePartner).toHaveBeenCalledWith('h-1', 200);
			expect(directory.createEntity).toHaveBeenCalledWith('h-1', data, false, { odooPartnerId: 200 });
			expect(row).toMatchObject({ id: 'e-new', odoo_partner_id: 200 });
		});

		it('crear con RUT duplicado confirmado: pasa allow_duplicate a la misma alta', async () => {
			const { service, odoo, directory } = build();

			odoo.findActivePartner.mockResolvedValue(candidate(200, null));
			await service.createWithPartner('h-1', data, 200, true);

			expect(directory.createEntity).toHaveBeenCalledWith('h-1', data, true, { odooPartnerId: 200 });
		});

		it('crear con partner ya vinculado: 409 partner_already_linked con razón social y cliente; ni consulta el ERP ni crea', async () => {
			const { service, odoo, directory } = build({
				linked: [{ id: 'e-9', legal_name: 'Otra SpA', odoo_partner_id: 200, client_name: 'Grupo Otro' }],
			});
			const error = await service.createWithPartner('h-1', data, 200).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(ConflictException);
			expect((error as { code?: string }).code).toBe('partner_already_linked');
			expect((error as ConflictException).message).toContain('"Otra SpA" del cliente Grupo Otro');
			expect(odoo.findActivePartner).not.toHaveBeenCalled();
			expect(directory.createEntity).not.toHaveBeenCalled();
		});

		it('crear con partner inexistente o archivado: 404 partner_not_found y no crea', async () => {
			const { service, odoo, directory } = build();

			odoo.findActivePartner.mockResolvedValue(null);
			const error = await service.createWithPartner('h-1', data, 999).catch((caught: unknown) => caught);

			expect(error).toBeInstanceOf(NotFoundException);
			expect((error as { code?: string }).code).toBe('partner_not_found');
			expect(directory.createEntity).not.toHaveBeenCalled();
		});

		it('crear con el ERP caído o sin conexión: 503 explicativo y no crea', async () => {
			const { service, odoo, directory } = build();

			odoo.findActivePartner.mockRejectedValue(new OdooConnectionError('no_connection', 'sin conexión'));

			await expect(service.createWithPartner('h-1', data, 200)).rejects.toBeInstanceOf(ServiceUnavailableException);
			expect(directory.createEntity).not.toHaveBeenCalled();
		});
	});

	it('partner actual: nombre desde Odoo, archivado si ya no está activo, y sin Odoo el bloqueo', async () => {
		const linked = build({ entity: { ...ENTITY, odoo_partner_id: 200 } });

		linked.odoo.findActivePartner
			.mockResolvedValueOnce(candidate(200, null))
			.mockResolvedValueOnce(null)
			.mockRejectedValueOnce(new Error('timeout'));

		expect((await linked.service.current('h-1', 'e-1')).current).toMatchObject({ odoo_partner_id: 200, name: 'Tompetrol SpA', archived: false });
		expect((await linked.service.current('h-1', 'e-1')).current).toMatchObject({ odoo_partner_id: 200, archived: true });
		expect((await linked.service.current('h-1', 'e-1')).blockers[0]).toMatchObject({ code: 'odoo_unavailable' });
		expect((await build().service.current('h-1', 'e-1')).current).toBeNull();
	});
});
