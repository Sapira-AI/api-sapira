import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';

import type { CreateProductDto, ProductsQueryDto, UpdateProductDto } from './dtos/products.dto';

type Row = Record<string, unknown>;
const count = (value: unknown) => Number(value ?? 0) || 0;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Uso y mapeos de cada producto. Uso = contratos y cotizaciones distintos que lo tienen en algún ítem, y precios (catálogo o de
 * contrato). Mapeos: Odoo y Stripe por columna del producto o tabla de mapeo; Salesforce = mapeos activos (+1 si la columna está).
 */
const PRODUCT_SELECT = `SELECT p.id, p.product_code, p.name, p.is_recurring, p.status, p.created_at,
	(SELECT count(DISTINCT ci.contract_id) FROM contract_items ci WHERE ci.product_id = p.id) AS contracts,
	(SELECT count(DISTINCT qi.quote_id) FROM quote_items qi WHERE qi.product_id = p.id) AS quotes,
	(SELECT count(*) FROM prices pr WHERE pr.product_id = p.id) AS prices,
	(SELECT count(*) FROM invoice_items ii WHERE ii.product_id = p.id) AS invoice_items,
	(SELECT count(*) FROM subscription_items si WHERE si.product_id = p.id) AS subscription_items,
	(p.odoo_product_id IS NOT NULL OR EXISTS (SELECT 1 FROM odoo_product_mappings m WHERE m.sapira_product_id = p.id)) AS odoo,
	(p.stripe_product_id IS NOT NULL OR EXISTS (SELECT 1 FROM stripe_product_mappings m WHERE m.sapira_product_id = p.id)) AS stripe,
	((SELECT count(*) FROM salesforce_product_mappings m WHERE m.sapira_product_id = p.id AND m.is_active)
		+ CASE WHEN p.salesforce_product_id IS NOT NULL THEN 1 ELSE 0 END) AS salesforce,
	(SELECT count(*) FROM salesforce_product_mappings m WHERE m.sapira_product_id = p.id) AS salesforce_rows
	FROM products p`;

const productDto = (row: Row) => ({
	id: String(row.id),
	product_code: (row.product_code as string | null) ?? null,
	name: (row.name as string | null) ?? null,
	is_recurring: row.is_recurring !== false,
	status: (row.status as string | null) ?? 'active',
	created_at: row.created_at,
	usage: { contracts: count(row.contracts), quotes: count(row.quotes), prices: count(row.prices) },
	mappings: { odoo: row.odoo === true, salesforce: count(row.salesforce), stripe: row.stripe === true },
});

/**
 * Productos en Precios (spec §1.5, D9): código, nombre, tipo y estado (`products.status`, M3). Sin precio ni moneda: viven en los precios
 * de catálogo (`default_price`/`default_currency` quedan quietas hasta el switch). Mapeos con integraciones: solo lectura.
 */
@Injectable()
export class ProductsService {
	constructor(private readonly dataSource: DataSource) {}

	async list(holdingId: string, query: ProductsQueryDto = {}) {
		const params: unknown[] = [holdingId];
		const filters: string[] = [];

		if (query.status && query.status !== 'all') filters.push(`p.status = $${params.push(query.status)}`);
		if (query.search) filters.push(`(p.name ILIKE $${params.push(`%${query.search}%`)} OR p.product_code ILIKE $${params.length})`);
		const rows = (await this.dataSource.query(
			`${PRODUCT_SELECT} WHERE p.holding_id = $1 ${filters.map((filter) => `AND ${filter}`).join(' ')} ORDER BY lower(p.name) NULLS LAST`,
			params
		)) as Row[];

		return rows.map(productDto);
	}

	private async findRow(holdingId: string, id: string): Promise<Row> {
		const [row] = (await this.dataSource.query(`${PRODUCT_SELECT} WHERE p.id = $1 AND p.holding_id = $2`, [id, holdingId])) as Row[];

		if (!row) throw new NotFoundException('Producto no encontrado');

		return row;
	}

	async get(holdingId: string, id: string) {
		return productDto(await this.findRow(holdingId, id));
	}

	/** Código único por holding sin distinguir mayúsculas ni espacios (la tabla no tiene constraint). */
	private async assertCodeFree(holdingId: string, code: string, excludeId: string | null) {
		const rows = (await this.dataSource.query(
			`SELECT 1 FROM products WHERE holding_id = $1 AND lower(btrim(product_code)) = lower(btrim($2)) AND id IS DISTINCT FROM $3::uuid LIMIT 1`,
			[holdingId, code, excludeId]
		)) as Row[];

		if (rows.length) throw new ConflictException(`Ya existe un producto con el código ${code}`);
	}

	private inUse(row: Row): number {
		return count(row.contracts) + count(row.quotes) + count(row.prices) + count(row.invoice_items) + count(row.subscription_items);
	}

	async create(holdingId: string, dto: CreateProductDto) {
		await this.assertCodeFree(holdingId, dto.product_code, null);
		const [row] = (await this.dataSource.query(
			`INSERT INTO products (holding_id, product_code, name, is_recurring, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
			[holdingId, dto.product_code, dto.name, dto.is_recurring ?? true]
		)) as Row[];

		return this.get(holdingId, String(row.id));
	}

	async update(holdingId: string, id: string, dto: UpdateProductDto) {
		const current = await this.findRow(holdingId, id);

		if (dto.product_code !== undefined) await this.assertCodeFree(holdingId, dto.product_code, id);
		if (dto.is_recurring !== undefined && dto.is_recurring !== (current.is_recurring !== false) && this.inUse(current) > 0) {
			throw new ConflictException('El producto está en uso: no se puede cambiar si es recurrente');
		}
		await this.dataSource.query(`UPDATE products SET product_code = $3, name = $4, is_recurring = $5 WHERE id = $1 AND holding_id = $2`, [
			id,
			holdingId,
			dto.product_code ?? current.product_code,
			dto.name ?? current.name,
			dto.is_recurring ?? current.is_recurring,
		]);

		return this.get(holdingId, id);
	}

	async setStatus(holdingId: string, id: string, status: 'active' | 'archived') {
		await this.findRow(holdingId, id);
		await this.dataSource.query(`UPDATE products SET status = $3 WHERE id = $1 AND holding_id = $2`, [id, holdingId, status]);

		return this.get(holdingId, id);
	}

	async remove(holdingId: string, id: string): Promise<void> {
		const row = await this.findRow(holdingId, id);

		if (this.inUse(row) > 0) {
			const parts = [
				count(row.contracts) ? plural(count(row.contracts), 'contrato', 'contratos') : '',
				count(row.quotes) ? plural(count(row.quotes), 'cotización', 'cotizaciones') : '',
				count(row.prices) ? plural(count(row.prices), 'precio', 'precios') : '',
				count(row.invoice_items) ? plural(count(row.invoice_items), 'línea de factura', 'líneas de factura') : '',
				count(row.subscription_items) ? plural(count(row.subscription_items), 'ítem de suscripción', 'ítems de suscripción') : '',
			].filter(Boolean);

			throw new ConflictException(`El producto está en uso (${parts.join(', ')}): archívalo en vez de eliminarlo`);
		}
		const linked = [
			row.odoo === true ? 'Odoo' : '',
			count(row.salesforce_rows) > 0 || count(row.salesforce) > 0 ? 'Salesforce' : '',
			row.stripe === true ? 'Stripe' : '',
		].filter(Boolean);

		if (linked.length) {
			throw new ConflictException(`El producto está vinculado con ${linked.join('/')}: quita el vínculo en Integraciones o archívalo`);
		}
		await this.dataSource.query(`DELETE FROM products WHERE id = $1 AND holding_id = $2`, [id, holdingId]);
	}
}
