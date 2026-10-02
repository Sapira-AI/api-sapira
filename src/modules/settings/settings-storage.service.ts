import { Injectable, InternalServerErrorException, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

/** Bucket público ya existente para logos (lo usa también el front actual). */
export const COMPANY_LOGOS_BUCKET = 'company-logos';
/** Bucket privado de archivos de compañías (migración M8 `1790790000000-CompanyLegalDocumentsStorage`). */
export const COMPANY_FILES_BUCKET = 'company-files';
const DOWNLOAD_URL_TTL_SECONDS = 60;

/**
 * Storage de Configuración con la clave de servicio, solo desde la API (regla de `AGENTS.md`: el navegador sube con URL firmada).
 * Mismo patrón que `ClientFilesStorageService` (Clientes, módulo cerrado), pero por bucket: logos (público) y documentos legales (privado).
 */
@Injectable()
export class SettingsStorageService {
	private readonly logger = new Logger(SettingsStorageService.name);
	private client: SupabaseClient | null = null;

	constructor(private readonly config: ConfigService) {}

	private supabase(): SupabaseClient {
		if (!this.client) {
			const url = this.config.get<string>('SUPABASE_URL');
			const key = this.config.get<string>('SUPABASE_SERVICE_ROLE_KEY');

			if (!url || !key) throw new ServiceUnavailableException('El almacenamiento de archivos no está configurado');
			this.client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
		}

		return this.client;
	}

	/** URL pública de un objeto del bucket de logos (no exige sesión: el bucket es público). */
	publicUrl(path: string): string {
		const base = String(this.config.get<string>('SUPABASE_URL') ?? '').replace(/\/+$/, '');

		return `${base}/storage/v1/object/public/${COMPANY_LOGOS_BUCKET}/${path}`;
	}

	/** Prefijo de URL pública aceptado como `logo_url` para una carpeta. */
	publicPrefix(folder: string): string {
		return this.publicUrl(`${folder.replace(/\/+$/, '')}/`);
	}

	async createUploadUrl(bucket: string, path: string): Promise<{ signedUrl: string; token: string }> {
		const { data, error } = await this.supabase().storage.from(bucket).createSignedUploadUrl(path);

		if (error || !data) {
			this.logger.error(`No se pudo firmar la subida de ${bucket}/${path}: ${error?.message}`);
			throw new InternalServerErrorException('No se pudo preparar la subida del archivo');
		}

		return { signedUrl: data.signedUrl, token: data.token };
	}

	/** Tamaño del objeto si existe; `null` si no está (la subida no terminó). */
	async objectSize(bucket: string, path: string): Promise<number | null> {
		const folder = path.slice(0, path.lastIndexOf('/'));
		const name = path.slice(path.lastIndexOf('/') + 1);
		const { data, error } = await this.supabase().storage.from(bucket).list(folder, { search: name, limit: 1 });

		if (error) throw new InternalServerErrorException('No se pudo verificar el archivo subido');
		const object = data?.find((item) => item.name === name);

		return object ? Number((object.metadata as { size?: number } | null)?.size ?? 0) : null;
	}

	async createDownloadUrl(bucket: string, path: string): Promise<string> {
		const { data, error } = await this.supabase().storage.from(bucket).createSignedUrl(path, DOWNLOAD_URL_TTL_SECONDS);

		if (error || !data) throw new InternalServerErrorException('No se pudo generar el enlace de descarga');

		return data.signedUrl;
	}

	/** Borra el objeto; si falla solo se registra (la fila ya se borró y el archivo queda huérfano en un bucket privado). */
	async remove(bucket: string, path: string): Promise<void> {
		const { error } = await this.supabase().storage.from(bucket).remove([path]);

		if (error) this.logger.warn(`No se pudo borrar ${bucket}/${path}: ${error.message}`);
	}
}

/** Nombre de archivo seguro para una ruta de Storage. */
export function safeFileName(name: string): string {
	const cleaned = name
		.normalize('NFD')
		.replace(/[̀-ͯ]/g, '')
		.replace(/[^a-zA-Z0-9._-]+/g, '_')
		.replace(/_+/g, '_')
		.replace(/^[._]+/, '')
		.slice(-120);

	return cleaned || 'archivo';
}

export const LOGO_MIME_TYPES: Record<string, string> = {
	'image/png': 'png',
	'image/jpeg': 'jpg',
	'image/webp': 'webp',
	'image/svg+xml': 'svg',
};
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

export const LEGAL_DOCUMENT_MIME_TYPES: readonly string[] = [
	'application/pdf',
	'image/png',
	'image/jpeg',
	'image/webp',
	'application/msword',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.ms-excel',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];
export const LEGAL_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;
