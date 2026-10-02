import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { CompanyLegalDocumentsService } from './company-legal-documents.service';
import { fakeDb, Handler } from './fake-db.testing-spec';
import { normalizeTaxRate, SettingsCompaniesService } from './settings-companies.service';
import { SettingsStorageService } from './settings-storage.service';

const HOLDING = '11111111-1111-4111-8111-111111111111';
const COMPANY = '66666666-6666-4666-8666-666666666666';
const ACCOUNT = '77777777-7777-4777-8777-777777777777';
const DOC = '88888888-8888-4888-8888-888888888888';

const companyRow = {
	id: COMPANY,
	legal_name: 'Hanka SpA',
	currency: 'CLP',
	country_code: 'CL',
	country: 'Chile',
	tax_rate: '0.19',
	logo_url: null,
	odoo_integration_id: null,
};
const base: Handler[] = [
	['FROM companies c WHERE c.id = $1 AND c.holding_id = $2', (params) => (params[1] === HOLDING && params[0] === COMPANY ? [companyRow] : [])],
	[
		'SELECT id, legal_name, currency FROM companies WHERE id = $1 AND holding_id = $2',
		(params) => (params[1] === HOLDING && params[0] === COMPANY ? [companyRow] : []),
	],
	['FROM currencies', (params) => (['CLP', 'USD'].includes(String(params[0])) ? [{ code: params[0] }] : [])],
	['FROM countries WHERE code', (params) => (params[0] === 'CL' ? [{ name_es: 'Chile' }] : [])],
	['FROM company_holdings WHERE id', () => [{ name: 'Hanka' }]],
];
const storage = {
	publicPrefix: (folder: string) => `https://sb/public/company-logos/${folder}/`,
	createUploadUrl: jest.fn(async () => ({ signedUrl: 'https://signed', token: 't' })),
	objectSize: jest.fn(),
	createDownloadUrl: jest.fn(async () => 'https://download'),
	remove: jest.fn(),
} as unknown as SettingsStorageService & { objectSize: jest.Mock; remove: jest.Mock };

const build = (handlers: Handler[] = []) => {
	const db = fakeDb([...handlers, ...base]);

	return { db, service: new SettingsCompaniesService(db as unknown as DataSource, storage) };
};
const usage = (counts: Record<string, number>): Handler[] => [
	['FROM contracts WHERE company_id', () => [{ n: counts.contracts ?? 0 }]],
	['FROM invoices WHERE company_id', () => [{ n: counts.invoices ?? 0 }]],
	['FROM accounting_period_cutoff WHERE company_id', () => [{ n: counts.periods ?? 0 }]],
];

describe('SettingsCompaniesService', () => {
	it('tax_rate siempre en porcentaje: 0.19 → 19; 19 → 19; null → null', () => {
		expect([normalizeTaxRate('0.19'), normalizeTaxRate(19), normalizeTaxRate(null), normalizeTaxRate(0)]).toEqual([19, 19, null, 0]);
	});

	it('compañía de otro holding → 404', async () => {
		const { service } = build();

		await expect(service.get('99999999-9999-4999-8999-999999999999', COMPANY)).rejects.toBeInstanceOf(NotFoundException);
		await expect(service.getAccounts('99999999-9999-4999-8999-999999999999', COMPANY)).rejects.toThrow('Compañía no encontrada');
	});

	it('crear: copia holding_name, valida país y moneda y escribe country con el nombre en español', async () => {
		const { db, service } = build([['INSERT INTO companies', () => [{ id: COMPANY }]]]);

		await expect(service.create(HOLDING, { legal_name: 'X', country_code: 'ZZ', currency: 'CLP' })).rejects.toThrow('País no reconocido: ZZ');
		await expect(service.create(HOLDING, { legal_name: 'X', country_code: 'CL', currency: 'XXX' })).rejects.toThrow('Moneda no reconocida: XXX');
		const company = await service.create(HOLDING, { legal_name: 'Hanka SpA', country_code: 'CL', currency: 'CLP', tax_rate: 19 });
		const params = db.statements('INSERT INTO companies')[0].params;

		expect(params.slice(0, 7)).toEqual([HOLDING, 'Hanka', 'Hanka SpA', null, 'CL', 'Chile', 'CLP']);
		expect(params[14]).toBe(19);
		expect(company.tax_rate).toBe(19);
	});

	it('cambiar la moneda con contratos o facturas → 409 (el trigger reescribiría los contratos)', async () => {
		const { db, service } = build(usage({ contracts: 12, invoices: 30 }));

		await expect(service.update(HOLDING, COMPANY, { currency: 'USD' })).rejects.toThrow(
			new ConflictException('No se puede cambiar la moneda: la compañía ya tiene 12 contratos y 30 facturas')
		);
		expect(db.statements('UPDATE companies')).toHaveLength(0);
	});

	it('la misma moneda o una compañía sin uso sí se actualiza', async () => {
		const { db, service } = build(usage({}));

		await service.update(HOLDING, COMPANY, { currency: 'USD', country_code: 'CL', tax_rate: 19 });
		const [update] = db.statements('UPDATE companies');

		expect(update.sql).toContain('tax_rate = $3, country_code = $4, country = $5, currency = $6');
		expect(update.params).toEqual([COMPANY, HOLDING, 19, 'CL', 'Chile', 'USD']);
	});

	it('logo_url de otra carpeta → 400', async () => {
		const { service } = build();

		await expect(service.update(HOLDING, COMPANY, { logo_url: 'https://sb/public/company-logos/companies/otra/x.png' })).rejects.toThrow(
			'El logo debe subirse con "Subir logo"'
		);
	});

	it('eliminar con uso → 409 listando lo que la bloquea; sin uso se borra', async () => {
		const used = build(usage({ contracts: 3, invoices: 10, periods: 2 }));

		await expect(used.service.remove(HOLDING, COMPANY)).rejects.toThrow(
			'No se puede eliminar: la compañía tiene 3 contratos, 10 facturas y 2 cierres de período'
		);
		const free = build(usage({}));

		await free.service.remove(HOLDING, COMPANY);
		expect(free.db.statements('DELETE FROM companies')[0].params).toEqual([COMPANY, HOLDING]);
	});

	describe('cuentas contables', () => {
		it('sin fila: no configurado y sin mostrar los defaults de la tabla', async () => {
			const { service } = build();
			const accounts = await service.getAccounts(HOLDING, COMPANY);

			expect(accounts).toMatchObject({ configured: false, complete: false });
			expect(accounts.accounts.map((account) => [account.key, account.code])).toEqual([
				['receivable', null],
				['deferred', null],
				['unbilled', null],
				['revenue', null],
				['fx_difference', null],
			]);
		});

		it('PUT exige las 5 claves una vez cada una', async () => {
			const { service } = build();
			const account = (key: string) => ({ key, code: '1', name: 'Cuenta' });

			await expect(service.putAccounts(HOLDING, COMPANY, { accounts: [account('revenue')] })).rejects.toThrow(
				'Faltan cuentas: receivable, deferred, unbilled, fx_difference'
			);
			await expect(service.putAccounts(HOLDING, COMPANY, { accounts: [account('revenue'), account('revenue')] })).rejects.toThrow(
				'Cuenta repetida: revenue'
			);
			await expect(service.putAccounts(HOLDING, COMPANY, { accounts: [account('otra')] })).rejects.toThrow('Clave de cuenta no válida: otra');
		});

		it('PUT hace upsert de las 15 columnas', async () => {
			const { db, service } = build();
			const accounts = ['receivable', 'deferred', 'unbilled', 'revenue', 'fx_difference'].map((key, index) => ({
				key,
				code: `1.${index}`,
				name: `Cuenta ${index}`,
				external_code: index === 3 ? '400100' : null,
			}));

			await service.putAccounts(HOLDING, COMPANY, { accounts });
			const [upsert] = db.statements('INSERT INTO company_account_mappings');

			expect(upsert.sql).toContain('receivable_account_code, receivable_account_name, external_receivable_code');
			expect(upsert.sql).toContain('ON CONFLICT (company_id) DO UPDATE');
			expect(upsert.params).toHaveLength(16);
		});
	});

	describe('cuentas bancarias', () => {
		it('cuenta repetida (banco + número sin separadores) → 409', async () => {
			const { service } = build([['regexp_replace(account_number', () => [{ 1: 1 }]]]);

			await expect(
				service.createBankAccount(HOLDING, COMPANY, {
					bank_name: 'BCI',
					account_type: 'Cuenta Corriente',
					account_number: '12-34',
					currency: 'CLP',
				})
			).rejects.toThrow('Ya existe esa cuenta (banco y número) en esta compañía');
		});

		it('con cargas de cartola no se elimina', async () => {
			const { db, service } = build([
				['WHERE a.id = $1 AND a.company_id = $2 AND a.holding_id = $3', () => [{ id: ACCOUNT, company_id: COMPANY, in_use: 3 }]],
			]);

			await expect(service.deleteBankAccount(HOLDING, COMPANY, ACCOUNT)).rejects.toThrow(
				'Esta cuenta tiene 3 cargas de cartola: no se puede eliminar'
			);
			expect(db.statements('DELETE FROM company_bank_accounts')).toHaveLength(0);
		});

		it('cuenta de otra compañía → 404', async () => {
			const { service } = build();

			await expect(service.updateBankAccount(HOLDING, COMPANY, ACCOUNT, { bank_name: 'X' })).rejects.toThrow('Cuenta bancaria no encontrada');
		});
	});
});

describe('CompanyLegalDocumentsService', () => {
	const build = (handlers: Handler[] = []) => {
		const db = fakeDb([...handlers, ...base]);

		return { db, service: new CompanyLegalDocumentsService(db as unknown as DataSource, storage) };
	};
	const confirm = (path: string) => ({
		document_id: DOC,
		path,
		document_name: 'Poder',
		document_type: 'Poder legal',
		file_name: 'poder.pdf',
		mime_type: 'application/pdf',
	});

	it('prepara la subida en el bucket privado bajo holding/compañía/legal/documento', async () => {
		const { service } = build();

		await expect(service.prepareUpload(HOLDING, COMPANY, { file_name: 'x.exe', mime_type: 'application/x-msdownload', size: 1 })).rejects.toThrow(
			'Tipo de archivo no permitido'
		);
		await expect(
			service.prepareUpload(HOLDING, COMPANY, { file_name: 'x.pdf', mime_type: 'application/pdf', size: 21 * 1024 * 1024 })
		).rejects.toThrow('El archivo no puede superar 20 MB');
		const upload = await service.prepareUpload(HOLDING, COMPANY, { file_name: 'Poder notarial.pdf', mime_type: 'application/pdf', size: 1000 });

		expect(upload.path).toBe(`${HOLDING}/${COMPANY}/legal/${upload.document_id}/Poder_notarial.pdf`);
		expect(storage.createUploadUrl).toHaveBeenCalledWith('company-files', upload.path);
	});

	it('confirmar: ruta ajena → 400; objeto no subido → 400; subido → registra la fila', async () => {
		const { db, service } = build([
			['WHERE d.id = $1 AND d.company_id = $2', () => [{ id: DOC, document_name: 'Poder', document_type: 'Poder legal', storage_path: 'p' }]],
		]);

		await expect(service.confirm(HOLDING, COMPANY, confirm(`otro/${COMPANY}/legal/${DOC}/poder.pdf`), 'u1')).rejects.toThrow(
			'La ruta del archivo no corresponde a esta compañía'
		);
		storage.objectSize.mockResolvedValueOnce(null);
		await expect(service.confirm(HOLDING, COMPANY, confirm(`${HOLDING}/${COMPANY}/legal/${DOC}/poder.pdf`), 'u1')).rejects.toThrow(
			'El archivo no se subió: vuelve a intentarlo'
		);
		storage.objectSize.mockResolvedValueOnce(2048);
		const document = await service.confirm(HOLDING, COMPANY, confirm(`${HOLDING}/${COMPANY}/legal/${DOC}/poder.pdf`), 'u1');

		expect(db.statements('INSERT INTO company_legal_documents')[0].params).toEqual([
			DOC,
			COMPANY,
			HOLDING,
			'Poder',
			'Poder legal',
			'company-files',
			`${HOLDING}/${COMPANY}/legal/${DOC}/poder.pdf`,
			'poder.pdf',
			'application/pdf',
			2048,
			'u1',
		]);
		expect(document.legacy).toBe(false);
	});

	it('eliminar borra la fila y el archivo', async () => {
		const { db, service } = build([
			['WHERE d.id = $1 AND d.company_id = $2', () => [{ id: DOC, storage_bucket: 'company-files', storage_path: 'a/b' }]],
		]);

		await service.remove(HOLDING, COMPANY, DOC);
		expect(db.statements('DELETE FROM company_legal_documents')).toHaveLength(1);
		expect(storage.remove).toHaveBeenCalledWith('company-files', 'a/b');
	});
});
