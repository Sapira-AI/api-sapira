import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Pertenencia de un usuario a un holding: fila activa en `user_holdings` (el mismo criterio con el que
 * `POST /holdings/select` deja cambiar de holding; los super admin tienen una fila por holding).
 */
@Injectable()
export class UserHoldingsService {
	constructor(private readonly dataSource: DataSource) {}

	/** `true` si el usuario de la sesión (`auth_id`) tiene una fila activa en `user_holdings` para ese holding. */
	async isActiveMember(authId: string, holdingId: string): Promise<boolean> {
		const rows = await this.dataSource.query<unknown[]>(
			`SELECT 1
			 FROM user_holdings uh
			 JOIN users u ON u.id = uh.user_id
			 WHERE u.auth_id = $1 AND uh.holding_id = $2 AND uh.is_active = true
			 LIMIT 1`,
			[authId, holdingId]
		);

		return rows.length > 0;
	}
}
