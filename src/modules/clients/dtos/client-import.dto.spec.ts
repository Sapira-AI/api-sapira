import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';

import { CLIENT_IMPORT_FIELDS, CLIENT_IMPORT_MAX_ROWS, ClientImportApplyDto, ClientImportPreviewDto } from './client-import.dto';

const validate = (dto: new () => object, body: unknown) =>
	validateSync(plainToInstance(dto, body) as object, { whitelist: true, forbidNonWhitelisted: true });
const messages = (errors: ReturnType<typeof validateSync>): string[] =>
	errors.flatMap((error) => [...Object.values(error.constraints ?? {}), ...messages(error.children ?? [])]);

describe('ClientImportPreviewDto / ClientImportApplyDto (importar para actualizar clientes)', () => {
	const row = (fields: Record<string, unknown>, key = 'CL-0021') => ({ row: 2, key, fields });

	it('acepta la clave, los campos mapeados y filas con solo los campos importables (recortados)', () => {
		const dto = plainToInstance(ClientImportApplyDto, {
			key_field: 'client_number',
			fields: ['industry', 'country'],
			label: ' clientes.xlsx ',
			rows: [row({ industry: ' Transporte ', country: 'Chile' })],
		});

		expect(validate(ClientImportApplyDto, dto)).toEqual([]);
		expect(dto.rows[0].fields.industry).toBe('Transporte');
		expect(dto.label).toBe('clientes.xlsx');
		expect(CLIENT_IMPORT_FIELDS).toEqual(['name_commercial', 'segment', 'industry', 'market', 'country', 'client_since', 'notes']);
	});

	it('rechaza claves y campos fuera de la lista, columnas desconocidas en la fila y fechas inválidas', () => {
		expect(messages(validate(ClientImportPreviewDto, { key_field: 'name', fields: ['industry'], rows: [row({ industry: 'x' })] }))).toContain(
			'Clave inválida: client_number o tax_id'
		);
		expect(messages(validate(ClientImportPreviewDto, { key_field: 'client_number', fields: ['custom_fields'], rows: [row({})] }))).toContain(
			'Campo no importable'
		);
		expect(messages(validate(ClientImportPreviewDto, { key_field: 'client_number', fields: [], rows: [row({})] }))).toContain(
			'Mapea al menos un campo para actualizar'
		);
		expect(
			messages(validate(ClientImportPreviewDto, { key_field: 'client_number', fields: ['notes'], rows: [row({ status: 'Inactivo' })] })).join(
				' '
			)
		).toContain('status');
		expect(
			messages(
				validate(ClientImportPreviewDto, {
					key_field: 'client_number',
					fields: ['client_since'],
					rows: [row({ client_since: '01-03-2024' })],
				})
			)
		).toContain('Cliente desde: fecha inválida (AAAA-MM-DD)');
		expect(
			messages(validate(ClientImportPreviewDto, { key_field: 'client_number', fields: ['notes'], rows: [row({ notes: 'x' }, '  ')] }))
		).toContain('Falta la clave de la fila');
	});

	it('limita las filas por importación', () => {
		const rows = Array.from({ length: CLIENT_IMPORT_MAX_ROWS + 1 }, (_, i) => ({ row: i + 2, key: `K${i}`, fields: {} }));

		expect(messages(validate(ClientImportPreviewDto, { key_field: 'client_number', fields: ['notes'], rows }))).toContain(
			`Máximo ${CLIENT_IMPORT_MAX_ROWS} filas por importación`
		);
	});
});
