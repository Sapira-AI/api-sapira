import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Veredicto del diagnóstico. Es el árbol de triage de la pierna de vuelta
 * (Odoo → Sapira) resuelto en una palabra, para no tener que interpretar los
 * conteos a mano.
 */
export type VeredictoAvisosOdoo = 'ok' | 'sin_avisos' | 'avisos_sin_efecto' | 'hueco_parcial';

export class DiagnosticoPorDiaDto {
	@ApiProperty({ description: 'Día en formato YYYY-MM-DD (UTC)', example: '2026-09-15' })
	dia: string;

	@ApiProperty({ description: 'Cantidad de registros de ese día', example: 12 })
	cantidad: number;
}

export class DiagnosticoUltimoAvisoDto {
	@ApiProperty({ description: 'Cuándo llegó el último aviso de Odoo', example: '2026-09-15T14:37:02.000Z' })
	recibido_en: Date;

	@ApiProperty({ description: 'Valor de `action` que mandó Odoo', example: 'write' })
	event_type: string;

	@ApiProperty({ description: 'Modelo de Odoo que mandó el aviso', example: 'account.move' })
	model: string;

	@ApiPropertyOptional({ description: 'ID del registro en Odoo', example: 198707 })
	odoo_id?: number;

	@ApiProperty({
		description:
			'Si el payload trae `x_sapira_invoice_id` en la raíz. Es el único amarre entre Odoo y Sapira: sin él el webhook no puede ' +
			'saber qué factura actualizar y sale en silencio.',
		example: true,
	})
	trae_x_sapira_invoice_id: boolean;

	@ApiProperty({
		description: 'Claves de primer nivel del payload, para comparar la forma que manda Odoo contra la que el webhook sabe leer.',
		example: ['id', 'name', 'state', 'payment_state', 'x_sapira_invoice_id'],
		type: [String],
	})
	claves_payload: string[];
}

export class DiagnosticoAvisosDto {
	@ApiProperty({ description: 'Avisos recibidos en toda la historia de la colección', example: 4312 })
	total_historico: number;

	@ApiProperty({ description: 'Avisos recibidos dentro de la ventana consultada', example: 0 })
	total_en_ventana: number;

	@ApiPropertyOptional({ description: 'Fecha del último aviso recibido, de toda la historia', example: '2026-09-15T14:37:02.000Z' })
	ultimo_en?: Date;

	@ApiPropertyOptional({ description: 'Horas transcurridas desde el último aviso', example: 391 })
	horas_sin_avisos?: number;

	@ApiProperty({ description: 'Avisos por día dentro de la ventana', type: [DiagnosticoPorDiaDto] })
	por_dia: DiagnosticoPorDiaDto[];

	@ApiPropertyOptional({ description: 'Resumen del último aviso recibido', type: DiagnosticoUltimoAvisoDto })
	ultimo_aviso?: DiagnosticoUltimoAvisoDto;
}

export class DiagnosticoActualizacionesDto {
	@ApiProperty({ description: 'Actualizaciones registradas en toda la historia', example: 3980 })
	total_historico: number;

	@ApiProperty({ description: 'Actualizaciones registradas dentro de la ventana', example: 0 })
	total_en_ventana: number;

	@ApiPropertyOptional({ description: 'Fecha de la última actualización registrada', example: '2026-09-15T14:37:03.000Z' })
	ultima_en?: Date;

	@ApiProperty({ description: 'Actualizaciones por día dentro de la ventana', type: [DiagnosticoPorDiaDto] })
	por_dia: DiagnosticoPorDiaDto[];
}

export class DiagnosticoFacturaDto {
	@ApiProperty({ description: 'ID de la factura en Sapira', example: '5652e95e-bb99-48f5-aa1c-13c8c2638fc6' })
	id: string;

	@ApiPropertyOptional({ description: 'Folio. Nulo es justamente el síntoma.', example: 'F101-00004388' })
	invoice_number?: string;

	@ApiProperty({ description: 'ID de la factura en Odoo', example: 198707 })
	odoo_invoice_id: number;

	@ApiProperty({ description: 'Estado en Sapira', example: 'Emitida' })
	status: string;

	@ApiPropertyOptional({ description: 'Cuándo Sapira la envió a Odoo', example: '2026-09-16T11:00:14.000Z' })
	sent_to_odoo_at?: Date;
}

export class DiagnosticoHuecoPorDiaDto {
	@ApiProperty({ description: 'Día de envío a Odoo, en formato YYYY-MM-DD', example: '2026-09-16' })
	dia: string;

	@ApiPropertyOptional({ description: 'País de la razón social emisora', example: 'Chile' })
	pais?: string;

	@ApiProperty({ description: 'Estado en Sapira', example: 'Emitida' })
	status: string;

	@ApiProperty({ description: 'Cantidad de facturas sin folio', example: 96 })
	cantidad: number;
}

export class DiagnosticoHuecoDto {
	@ApiProperty({ description: 'Facturas enviadas a Odoo que siguen sin folio en Sapira', example: 154 })
	total: number;

	@ApiProperty({ description: 'Desglose por día de envío, país y estado', type: [DiagnosticoHuecoPorDiaDto] })
	por_dia_y_pais: DiagnosticoHuecoPorDiaDto[];

	@ApiProperty({ description: 'IDs de Odoo de las facturas sin folio, para el backfill', example: [198706, 198707, 198708], type: [Number] })
	odoo_invoice_ids: number[];

	@ApiProperty({ description: 'Si `odoo_invoice_ids` quedó recortada por el límite de la consulta', example: false })
	lista_truncada: boolean;
}

export class DiagnosticoCorteDto {
	@ApiPropertyOptional({
		description: 'Última factura cuyo aviso sí llegó (estado Enviada o Pagada). Su `sent_to_odoo_at` pone el corte al minuto.',
		type: DiagnosticoFacturaDto,
	})
	ultima_con_aviso?: DiagnosticoFacturaDto;

	@ApiPropertyOptional({
		description: 'Primera factura sin folio posterior a la anterior: el otro borde del corte.',
		type: DiagnosticoFacturaDto,
	})
	primera_sin_aviso?: DiagnosticoFacturaDto;
}

export class OdooWebhookDiagnosticsDto {
	@ApiProperty({ description: 'Cuándo se generó el reporte', example: '2026-10-01T18:22:41.000Z' })
	generado_en: Date;

	@ApiProperty({ description: 'Inicio de la ventana consultada', example: '2026-09-01T18:22:41.000Z' })
	desde: Date;

	@ApiProperty({ description: 'Días de la ventana consultada', example: 30 })
	dias: number;

	@ApiPropertyOptional({ description: 'Holding al que se acotó el reporte, si se pidió uno', example: '123e4567-e89b-12d3-a456-426614174000' })
	holding_id?: string;

	@ApiProperty({
		description:
			'`ok`: sin hueco. `sin_avisos`: hay facturas sin folio y Odoo no llamó en la ventana (automated action apagada, URL cambiada, ' +
			'o la llamada se rechaza antes de llegar al controller). `avisos_sin_efecto`: Odoo llama pero ninguna actualización se aplicó ' +
			'(el payload no trae lo que el webhook necesita). `hueco_parcial`: llegan y se aplican avisos, pero igual hay facturas sin folio.',
		enum: ['ok', 'sin_avisos', 'avisos_sin_efecto', 'hueco_parcial'],
		example: 'sin_avisos',
	})
	veredicto: VeredictoAvisosOdoo;

	@ApiProperty({ description: 'Avisos que Odoo mandó al webhook', type: DiagnosticoAvisosDto })
	avisos_recibidos: DiagnosticoAvisosDto;

	@ApiProperty({ description: 'Actualizaciones que el webhook aplicó sobre facturas', type: DiagnosticoActualizacionesDto })
	actualizaciones_aplicadas: DiagnosticoActualizacionesDto;

	@ApiProperty({ description: 'Facturas que Sapira envió a Odoo y siguen sin folio', type: DiagnosticoHuecoDto })
	facturas_sin_folio: DiagnosticoHuecoDto;

	@ApiProperty({ description: 'Los dos bordes del corte', type: DiagnosticoCorteDto })
	corte: DiagnosticoCorteDto;
}
