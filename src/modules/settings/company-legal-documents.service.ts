import { randomUUID } from 'crypto';

import { Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { validationException } from '@/core/utils/validation-errors';

import { assertCompanyInHolding, Row, toIsoDate, toNumber, withUniqueMessage } from './settings-common';
import {
	COMPANY_FILES_BUCKET,
	LEGAL_DOCUMENT_MAX_BYTES,
	LEGAL_DOCUMENT_MIME_TYPES,
	safeFileName,
	SettingsStorageService,
} from './settings-storage.service';

import type { ConfirmLegalDocumentDto, LegalDocumentUploadDto } from './dtos/companies.dto';

const documentDto = (row: Row) => ({
	id: String(row.id),
	document_name: String(row.document_name),
	document_type: String(row.document_type),
	upload_date: toIsoDate(row.upload_date),
	file_name: (row.file_name as string | null) ?? null,
	mime_type: (row.mime_type as string | null) ?? null,
	file_size: toNumber(row.file_size),
	uploaded_by_name: (row.uploaded_by_name as string | null) ?? null,
	legacy: !row.storage_path,
	file_url: row.storage_path ? null : ((row.file_url as string | null) ?? null),
	created_at: row.created_at,
});

/**
 * Documentos legales de la Compañía 360 (D13) con subida real: el navegador sube a una URL firmada del bucket privado `company-files`
 * (M8) y la API confirma que el objeto existe antes de registrar la fila en `company_legal_documents`. Ruta
 * `<holding_id>/<company_id>/legal/<document_id>/<archivo>`. Las filas antiguas (sin `storage_path`) se muestran como `legacy`.
 */
@Injectable()
export class CompanyLegalDocumentsService {
	constructor(
		private readonly dataSource: DataSource,
		private readonly storage: SettingsStorageService
	) {}

	private folder(holdingId: string, companyId: string, documentId: string) {
		return `${holdingId}/${companyId}/legal/${documentId}/`;
	}

	async list(holdingId: string, companyId: string) {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		const rows = (await this.dataSource.query(
			`SELECT d.*, u.name AS uploaded_by_name FROM company_legal_documents d LEFT JOIN users u ON u.id = d.uploaded_by
			WHERE d.company_id = $1 AND d.holding_id = $2 ORDER BY d.upload_date DESC, d.created_at DESC`,
			[companyId, holdingId]
		)) as Row[];

		return rows.map(documentDto);
	}

	private assertFile(mimeType: string, size?: number) {
		if (!LEGAL_DOCUMENT_MIME_TYPES.includes(mimeType))
			throw validationException([{ field: 'mime_type', message: 'Tipo de archivo no permitido' }]);
		if (size !== undefined && size > LEGAL_DOCUMENT_MAX_BYTES) {
			throw validationException([{ field: 'size', message: 'El archivo no puede superar 20 MB' }]);
		}
	}

	async prepareUpload(holdingId: string, companyId: string, input: LegalDocumentUploadDto) {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		this.assertFile(input.mime_type, input.size);
		const documentId = randomUUID();
		const path = `${this.folder(holdingId, companyId, documentId)}${safeFileName(input.file_name)}`;
		const upload = await this.storage.createUploadUrl(COMPANY_FILES_BUCKET, path);

		return { document_id: documentId, path, upload_url: upload.signedUrl, token: upload.token };
	}

	async confirm(holdingId: string, companyId: string, input: ConfirmLegalDocumentDto, userId: string | null) {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		this.assertFile(input.mime_type);
		const folder = this.folder(holdingId, companyId, input.document_id);

		if (!input.path.startsWith(folder) || input.path.slice(folder.length).includes('/') || input.path.includes('..')) {
			throw validationException([{ field: 'path', message: 'La ruta del archivo no corresponde a esta compañía' }]);
		}
		const size = await this.storage.objectSize(COMPANY_FILES_BUCKET, input.path);

		if (size === null) throw validationException([{ field: 'path', message: 'El archivo no se subió: vuelve a intentarlo' }]);
		// Confirmar dos veces el mismo `document_id` (doble clic, reintento) → 409, no 500.
		await withUniqueMessage(
			() =>
				this.dataSource.query(
					`INSERT INTO company_legal_documents (id, company_id, holding_id, document_name, document_type, upload_date, storage_bucket, storage_path,
				file_name, mime_type, file_size, uploaded_by)
			VALUES ($1, $2, $3, $4, $5, CURRENT_DATE, $6, $7, $8, $9, $10, $11)`,
					[
						input.document_id,
						companyId,
						holdingId,
						input.document_name,
						input.document_type,
						COMPANY_FILES_BUCKET,
						input.path,
						input.file_name,
						input.mime_type,
						size,
						userId,
					]
				),
			'Este documento ya está registrado'
		);

		return documentDto(await this.find(holdingId, companyId, input.document_id));
	}

	private async find(holdingId: string, companyId: string, documentId: string): Promise<Row> {
		const [row] = (await this.dataSource.query(
			`SELECT d.*, u.name AS uploaded_by_name FROM company_legal_documents d LEFT JOIN users u ON u.id = d.uploaded_by
			WHERE d.id = $1 AND d.company_id = $2 AND d.holding_id = $3`,
			[documentId, companyId, holdingId]
		)) as Row[];

		if (!row) throw new NotFoundException('Documento no encontrado');

		return row;
	}

	async downloadUrl(holdingId: string, companyId: string, documentId: string) {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		const row = await this.find(holdingId, companyId, documentId);

		if (row.storage_path)
			return { url: await this.storage.createDownloadUrl(String(row.storage_bucket ?? COMPANY_FILES_BUCKET), String(row.storage_path)) };
		if (row.file_url) return { url: String(row.file_url) };
		throw new NotFoundException('El documento no tiene archivo');
	}

	async remove(holdingId: string, companyId: string, documentId: string): Promise<void> {
		await assertCompanyInHolding(this.dataSource, holdingId, companyId);
		const row = await this.find(holdingId, companyId, documentId);

		await this.dataSource.query(`DELETE FROM company_legal_documents WHERE id = $1 AND company_id = $2`, [documentId, companyId]);
		if (row.storage_path) await this.storage.remove(String(row.storage_bucket ?? COMPANY_FILES_BUCKET), String(row.storage_path));
	}
}
