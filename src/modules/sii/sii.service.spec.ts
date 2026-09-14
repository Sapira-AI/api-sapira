import { BadRequestException, NotFoundException } from '@nestjs/common';

import { SiiService } from './sii.service';

describe('SiiService factura integration', () => {
	const company = {
		id: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6',
		holding_id: 'd2719d82-5d77-4cf2-9a51-faa3eb18b488',
		legal_name: 'Empresa Demo SpA',
		tax_id: '76123456-7',
		legal_address: 'Av. Principal 1',
		country: 'chile',
	};

	function createService(overrides?: { company?: typeof company | null; provision?: jest.Mock; save?: jest.Mock }) {
		const queryBuilder = {
			where: jest.fn().mockReturnThis(),
			andWhere: jest.fn().mockReturnThis(),
			orderBy: jest.fn().mockReturnThis(),
			getMany: jest.fn().mockResolvedValue(overrides?.company === undefined ? [company] : overrides.company ? [overrides.company] : []),
		};
		const companies = {
			createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
			findOne: jest.fn().mockResolvedValue(overrides?.company === undefined ? company : overrides.company),
		};
		const configurations = {
			find: jest.fn().mockResolvedValue([]),
			findOne: jest.fn().mockResolvedValue(null),
			create: jest.fn((value) => value),
			merge: jest.fn((_current, next) => next),
			save: overrides?.save || jest.fn(async (value) => ({ id: 'config-1', ...value })),
		};
		const dataSource = {
			query: jest.fn().mockResolvedValue([{ holding_id: company.holding_id }]),
		};
		const facturaClient = {
			provisionEmpresa: overrides?.provision || jest.fn().mockResolvedValue({ data: { empresaId: '6aa0f12c3f130f57fcb69224' } }),
		};
		const service = new SiiService(
			companies as any,
			configurations as any,
			{} as any,
			{} as any,
			dataSource as any,
			{} as any,
			facturaClient as any
		);
		return { service, facturaClient, companies, configurations };
	}

	it('lists Chilean companies with facturaStatus not_linked by default', async () => {
		const { service } = createService();
		await expect(service.eligibleCompanies('auth-1')).resolves.toEqual([
			expect.objectContaining({
				id: company.id,
				legalName: company.legal_name,
				taxId: company.tax_id,
				facturaStatus: 'not_linked',
			}),
		]);
	});

	it('provisions a holding company in api-factura', async () => {
		const { service, facturaClient } = createService();
		await expect(
			service.integrateWithFactura('auth-1', company.id, {
				business_activity: 'Software',
				commune: 'Santiago',
				city: 'Santiago',
			})
		).resolves.toEqual(expect.objectContaining({ linked: true, sapiraCompanyId: company.id, empresaId: '6aa0f12c3f130f57fcb69224' }));
		expect(facturaClient.provisionEmpresa).toHaveBeenCalledWith(
			expect.objectContaining({
				externalReference: { companyId: company.id, tenantId: company.holding_id },
				rut: company.tax_id,
				razonSocial: company.legal_name,
			})
		);
	});

	it('rejects a company outside the selected holding', async () => {
		const { service } = createService({ company: null });
		await expect(service.integrateWithFactura('auth-1', 'other-company', {})).rejects.toBeInstanceOf(NotFoundException);
	});

	it('rejects a company missing tax identity', async () => {
		const { service, facturaClient } = createService({ company: { ...company, tax_id: undefined } as any });
		await expect(
			service.integrateWithFactura('auth-1', company.id, { business_activity: 'Software', commune: 'Santiago', city: 'Santiago' })
		).rejects.toBeInstanceOf(BadRequestException);
		expect(facturaClient.provisionEmpresa).not.toHaveBeenCalled();
	});
});
