import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CONTRACT_DOCUMENT_URL_TTL_SECONDS, ContractDocumentsStorageService } from './contract-documents-storage.service';

const createSignedUrl = jest.fn();

jest.mock('@supabase/supabase-js', () => ({
	createClient: jest.fn(() => ({ storage: { from: jest.fn(() => ({ createSignedUrl })) } })),
}));

const config = (values: Record<string, string | undefined>) => ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('ContractDocumentsStorageService', () => {
	beforeEach(() => createSignedUrl.mockReset());

	it('sin clave de servicio responde 409 con mensaje en español (sin tocar Storage)', async () => {
		const service = new ContractDocumentsStorageService(config({ SUPABASE_URL: 'https://x.supabase.co' }));

		await expect(service.createDownloadUrl('c-1/1.pdf')).rejects.toBeInstanceOf(ConflictException);
		await expect(service.createDownloadUrl('c-1/1.pdf')).rejects.toThrow(/no está disponible/);
		expect(createSignedUrl).not.toHaveBeenCalled();
	});

	it('firma la descarga en el bucket contract-documents por 60 s y devuelve el vencimiento', async () => {
		createSignedUrl.mockResolvedValue({ data: { signedUrl: 'https://x.supabase.co/sign/c-1/1.pdf?token=t' }, error: null });
		const service = new ContractDocumentsStorageService(config({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }));

		await expect(service.createDownloadUrl('c-1/1.pdf', new Date('2026-09-25T12:00:00.000Z'))).resolves.toEqual({
			url: 'https://x.supabase.co/sign/c-1/1.pdf?token=t',
			expires_at: '2026-09-25T12:01:00.000Z',
		});
		expect(createSignedUrl).toHaveBeenCalledWith('c-1/1.pdf', CONTRACT_DOCUMENT_URL_TTL_SECONDS, { download: true });
	});

	it('si Storage falla responde 500 con mensaje genérico', async () => {
		createSignedUrl.mockResolvedValue({ data: null, error: { message: 'Object not found' } });
		const service = new ContractDocumentsStorageService(config({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }));

		await expect(service.createDownloadUrl('c-1/1.pdf')).rejects.toBeInstanceOf(InternalServerErrorException);
	});
});
