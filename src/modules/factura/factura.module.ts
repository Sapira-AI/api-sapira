import { Module } from '@nestjs/common';

import { FacturaClientService } from './factura-client.service';
import { FacturaOAuthService } from './factura-oauth.service';

@Module({
	providers: [FacturaOAuthService, FacturaClientService],
	exports: [FacturaClientService],
})
export class FacturaModule {}
