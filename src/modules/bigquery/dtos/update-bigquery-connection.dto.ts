import { PartialType } from '@nestjs/swagger';

import { CreateBigQueryConnectionDto } from './create-bigquery-connection.dto';

export class UpdateBigQueryConnectionDto extends PartialType(CreateBigQueryConnectionDto) {}
