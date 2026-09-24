import { randomUUID } from 'crypto';

import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

import { UserHoldingsService } from '@/guards/user-holdings.service';

import { CLIENT_FILES_BUCKET, ClientFilesStorageService } from './storage/client-files-storage.service';

type Row = Record<string, unknown>;

/** Tipos permitidos (espejo de `allowed_mime_types` del bucket `client-files`). */
export const CLIENT_DOCUMENT_MIME_TYPES = [
	'application/pdf',
	'image/png',
	'image/jpeg',
	'image/webp',
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
	'application/msword',
	'application/vnd.ms-excel',
	'text/csv',
	'text/plain',
] as const;
export const CLIENT_DOCUMENT_MAX_BYTES = 20 * 1024 * 1024;

const text = (value: unknown) => (value === null || value === undefined || value === '' ? null : String(value));

/** Nombre de archivo seguro para la ruta en Storage (el nombre original se guarda aparte). */
function safeFileName(name: string) {
	const base = name
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^[-.]+|[-.]+$/g, '');

	return (base || 'archivo').slice(0, 120);
}

/**
 * Documentos del cliente comercial (pestaña Documentos del Cliente 360). Los nuevos van al bucket privado
 * `client-files`: el navegador sube con una URL firmada (2 pasos: preparar → subir → confirmar) y abre con una URL
 * firmada de 60 s. `file_url` guarda el enlace de descarga del front nuevo para que la app actual los siga abriendo
 * (comparten la sesión en `.aisapira.com`). Los documentos antiguos del bucket público se muestran con su URL.
 */
@Injectable()
export class ClientDocumentsService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly storage: ClientFilesStorageService,
		private readonly userHoldings: UserHoldingsService,
		private readonly config: ConfigService
	) {}

	private async assertClientInHolding(clientId: string, holdingId: string) {
		const rows = await this.dataSource.query<Row[]>(`SELECT 1 FROM clients WHERE id = $1 AND holding_id = $2`, [clientId, holdingId]);

		if (rows.length === 0) throw new NotFoundException('Cliente no encontrado');
	}

	private async userId(authId: string): Promise<string | null> {
		const [row] = await this.dataSource.query<Row[]>(`SELECT id FROM users WHERE auth_id = $1 LIMIT 1`, [authId]);

		return row ? String(row.id) : null;
	}

	/** Enlace estable que se guarda en `file_url`: la ruta de descarga del front nuevo. */
	private documentLink(documentId: string) {
		const base = (this.config.get<string>('DOCUMENTS_LINK_BASE_URL') || 'http://localhost:8081').replace(/\/+$/, '');

		return `${base}/api/documentos/${documentId}/descargar`;
	}

	async list(clientId: string, holdingId: string) {
		await this.assertClientInHolding(clientId, holdingId);
		const rows = await this.dataSource.query<Row[]>(
			`SELECT d.id, d.document_name, d.mime_type, d.file_size, d.uploaded_at, d.storage_path, d.file_url,
				d.client_entity_id, ce.legal_name, u.name AS uploaded_by_name
			FROM client_documents d
			LEFT JOIN client_entities ce ON ce.id = d.client_entity_id
			LEFT JOIN users u ON u.id = d.uploaded_by
			WHERE d.client_id = $1 AND d.holding_id = $2 AND d.deleted_at IS NULL
			ORDER BY d.uploaded_at DESC NULLS LAST, d.id`,
			[clientId, holdingId]
		);

		return rows.map((row) => ({
			id: String(row.id),
			name: text(row.document_name) ?? 'Documento',
			mime_type: text(row.mime_type),
			file_size: row.file_size === null ? null : Number(row.file_size),
			uploaded_at: row.uploaded_at ? new Date(String(row.uploaded_at)).toISOString() : null,
			uploaded_by_name: text(row.uploaded_by_name),
			client_entity_id: text(row.client_entity_id),
			legal_name: text(row.legal_name),
			/** Antiguo: vive en el bucket público de la app actual (se abre con su URL). */
			legacy: !row.storage_path,
		}));
	}

	/** Paso 1: valida y firma la subida. La fila se crea recién al confirmar (paso 3), así no quedan huérfanas. */
	async prepareUpload(clientId: string, holdingId: string, input: { name: string; mime_type: string; size: number }) {
		await this.assertClientInHolding(clientId, holdingId);
		if (!(CLIENT_DOCUMENT_MIME_TYPES as readonly string[]).includes(input.mime_type)) {
			throw new BadRequestException('Tipo de archivo no permitido. Sube PDF, imágenes, Word, Excel, CSV o texto.');
		}
		if (input.size <= 0 || input.size > CLIENT_DOCUMENT_MAX_BYTES) throw new BadRequestException('El archivo debe pesar como máximo 20 MB.');

		const documentId = randomUUID();
		const path = `${holdingId}/${clientId}/${documentId}/${safeFileName(input.name)}`;
		const upload = await this.storage.createUploadUrl(path);

		return { document_id: documentId, path, upload_url: upload.signedUrl, token: upload.token };
	}

	/** Paso 3: verifica que el archivo quedó en Storage y registra el documento. */
	async confirmUpload(
		clientId: string,
		holdingId: string,
		authId: string,
		input: { document_id: string; path: string; name: string; mime_type: string; client_entity_id?: string }
	) {
		await this.assertClientInHolding(clientId, holdingId);
		if (!input.path.startsWith(`${holdingId}/${clientId}/${input.document_id}/`))
			throw new ForbiddenException('La ruta no corresponde a este cliente');
		if (input.client_entity_id) {
			const linked = await this.dataSource.query<Row[]>(
				`SELECT 1 FROM client_entity_clients WHERE client_entity_id = $1 AND client_id = $2 AND holding_id = $3`,
				[input.client_entity_id, clientId, holdingId]
			);

			if (linked.length === 0) throw new BadRequestException('La razón social no está vinculada a este cliente');
		}

		const size = await this.storage.objectSize(input.path);

		if (size === null) throw new BadRequestException('El archivo no terminó de subirse. Intenta de nuevo.');

		await this.dataSource.query(
			`INSERT INTO client_documents (id, client_id, holding_id, document_name, file_url, uploaded_at, storage_bucket, storage_path, file_size, mime_type, uploaded_by, client_entity_id)
			VALUES ($1, $2, $3, $4, $5, now(), $6, $7, $8, $9, $10, $11)
			ON CONFLICT (id) DO NOTHING`,
			[
				input.document_id,
				clientId,
				holdingId,
				input.name.trim().slice(0, 200) || 'Documento',
				this.documentLink(input.document_id),
				CLIENT_FILES_BUCKET,
				input.path,
				size,
				input.mime_type,
				await this.userId(authId),
				input.client_entity_id ?? null,
			]
		);

		return { id: input.document_id };
	}

	/**
	 * URL para abrir un documento. Se pide por id y sin header de holding (la usan los enlaces guardados, también
	 * desde la app actual): el holding sale del registro y se valida que el usuario pertenezca a él.
	 */
	async downloadUrl(documentId: string, authId: string): Promise<string> {
		const [row] = await this.dataSource.query<Row[]>(
			`SELECT holding_id, storage_path, file_url FROM client_documents WHERE id = $1 AND deleted_at IS NULL`,
			[documentId]
		);

		if (!row || !(await this.userHoldings.isActiveMember(authId, String(row.holding_id)))) throw new NotFoundException('Documento no encontrado');
		if (row.storage_path) return this.storage.createDownloadUrl(String(row.storage_path));
		if (row.file_url) return String(row.file_url);
		throw new NotFoundException('El documento no tiene archivo');
	}

	/**
	 * Archiva el documento (borrado lógico): deja de verse en el front nuevo y el archivo se conserva. La app actual
	 * no conoce `deleted_at` y lo seguiría mostrando (pendiente: filtrar en su policy RLS o migrar esa pantalla).
	 */
	async archive(clientId: string, documentId: string, holdingId: string) {
		const result = await this.dataSource.query<Row[]>(
			`UPDATE client_documents SET deleted_at = now() WHERE id = $1 AND client_id = $2 AND holding_id = $3 AND deleted_at IS NULL RETURNING id`,
			[documentId, clientId, holdingId]
		);

		if (result.length === 0) throw new NotFoundException('Documento no encontrado');

		return { id: documentId };
	}
}
