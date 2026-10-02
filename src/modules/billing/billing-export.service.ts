import { Injectable } from '@nestjs/common';

import { buildWorkbook, type Cell, INVOICE_HEADER, invoiceCells, LINE_HEADER, lineCells, type Sheet, XLSX_CONTENT_TYPE } from './billing-export';
import { BillingReadService } from './billing-read.service';

import type { BillingExportQueryDto } from './dtos/billing.dto';
import type { Writable } from 'stream';

/**
 * `GET /billing/invoices/export` (spec §4.8): XLSX de la vista filtrada (mismos filtros y orden que la lista), sin corte (lotes de 1.000),
 * encabezados o encabezados + líneas. Se envía como stream (`generateNodeStream`).
 */
@Injectable()
export class BillingExportService {
	constructor(private readonly read: BillingReadService) {}

	async workbook(holdingId: string, query: BillingExportQueryDto, now = new Date()) {
		const header: Cell[][] = [];
		const lines: Cell[][] = [];
		const withLines = query.detail === 'lines';

		await this.read.exportBatches(
			holdingId,
			query,
			async (rows) => {
				for (const row of rows) header.push(invoiceCells(row, row.related_invoice_number));
				if (!withLines) return;
				const byInvoice = new Map(rows.map((row) => [row.id, row]));

				for (const line of await this.read.exportLines(
					holdingId,
					rows.map((row) => row.id)
				)) {
					const invoice = byInvoice.get(String(line.invoice_id));

					if (invoice) lines.push(lineCells(line, invoice));
				}
			},
			now
		);
		const sheets: Sheet[] = [{ name: 'Facturas', header: INVOICE_HEADER, rows: header }];

		if (withLines) sheets.push({ name: 'Líneas', header: LINE_HEADER, rows: lines });

		return { zip: buildWorkbook(sheets), rows: header.length };
	}

	async stream(
		holdingId: string,
		query: BillingExportQueryDto,
		response: Writable & { setHeader(name: string, value: string): unknown },
		now = new Date()
	) {
		const { zip } = await this.workbook(holdingId, query, now);
		const stamp = this.read.today(now);

		response.setHeader('Content-Type', XLSX_CONTENT_TYPE);
		response.setHeader(
			'Content-Disposition',
			`attachment; filename="facturacion-${query.detail === 'lines' ? 'lineas' : 'facturas'}-${stamp}.xlsx"`
		);
		await new Promise<void>((resolve, reject) => {
			zip.generateNodeStream({ type: 'nodebuffer', streamFiles: true, compression: 'DEFLATE' })
				.on('error', reject)
				.pipe(response)
				.on('finish', () => resolve())
				.on('error', reject);
		});
	}
}
