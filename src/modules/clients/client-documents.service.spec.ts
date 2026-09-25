import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { UserHoldingsService } from '@/guards/user-holdings.service';

import { ClientDocumentsService } from './client-documents.service';
import { ClientFilesStorageService } from './storage/client-files-storage.service';

const H = 'h-1';
const C = 'c-1';

const build = ({ member = true, objectSize = 1024 as number | null } = {}) => {
	const query = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) => {
		if (sql.includes('FROM clients WHERE id')) return [{ '?column?': 1 }];
		if (sql.includes('FROM users WHERE auth_id')) return [{ id: 'u-1' }];
		if (sql.includes('SELECT holding_id, storage_path')) return [{ holding_id: H, storage_path: `${H}/${C}/d-1/contrato.pdf`, file_url: null }];

		return [];
	});
	const storage = {
		createUploadUrl: jest.fn().mockResolvedValue({ signedUrl: 'https://storage/upload?token=t', token: 't' }),
		objectSize: jest.fn().mockResolvedValue(objectSize),
		createDownloadUrl: jest.fn().mockResolvedValue('https://storage/signed'),
	} as unknown as ClientFilesStorageService;
	const holdings = { isActiveMember: jest.fn().mockResolvedValue(member) } as unknown as UserHoldingsService;
	const config = { get: jest.fn().mockReturnValue('https://www.aisapira.com/') } as unknown as ConfigService;

	return { service: new ClientDocumentsService({ query } as unknown as DataSource, storage, holdings, config), query, storage };
};

describe('ClientDocumentsService', () => {
	it('prepara la subida con una ruta segura dentro de holding/cliente', async () => {
		const { service, storage } = build();
		const result = await service.prepareUpload(C, H, { name: 'Contrato Firmado (versión final).pdf', mime_type: 'application/pdf', size: 2048 });

		expect(result.path).toMatch(new RegExp(`^${H}/${C}/${result.document_id}/Contrato-Firmado-version-final-.pdf$`));
		expect(storage.createUploadUrl).toHaveBeenCalledWith(result.path);
	});

	it('rechaza tipos no permitidos y archivos de más de 20 MB', async () => {
		const { service } = build();

		await expect(service.prepareUpload(C, H, { name: 'x.exe', mime_type: 'application/x-msdownload', size: 10 })).rejects.toBeInstanceOf(
			BadRequestException
		);
		await expect(service.prepareUpload(C, H, { name: 'x.pdf', mime_type: 'application/pdf', size: 21 * 1024 * 1024 })).rejects.toBeInstanceOf(
			BadRequestException
		);
	});

	it('confirma solo rutas del cliente y archivos que llegaron a Storage; guarda el enlace del front nuevo', async () => {
		const input = { document_id: 'd-1', path: `${H}/${C}/d-1/contrato.pdf`, name: 'contrato.pdf', mime_type: 'application/pdf' };

		await expect(build().service.confirmUpload(C, H, 'auth-1', { ...input, path: `otro/${C}/d-1/x.pdf` })).rejects.toBeInstanceOf(
			ForbiddenException
		);
		await expect(build({ objectSize: null }).service.confirmUpload(C, H, 'auth-1', input)).rejects.toBeInstanceOf(BadRequestException);

		const { service, query } = build();

		await service.confirmUpload(C, H, 'auth-1', input);
		const insert = query.mock.calls.find(([sql]) => (sql as string).includes('INSERT INTO client_documents'))!;

		expect((insert[1] as unknown[])[4]).toBe('https://www.aisapira.com/api/documentos/d-1/descargar');
		expect((insert[1] as unknown[])[6]).toBe(input.path);
	});

	it('descarga solo si el usuario pertenece al holding del documento', async () => {
		await expect(build().service.downloadUrl('d-1', 'auth-1')).resolves.toBe('https://storage/signed');
		await expect(build({ member: false }).service.downloadUrl('d-1', 'auth-1')).rejects.toBeInstanceOf(NotFoundException);
	});
});
