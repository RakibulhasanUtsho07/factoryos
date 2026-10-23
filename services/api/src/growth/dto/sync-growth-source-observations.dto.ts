import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsString, Matches, IsUUID } from 'class-validator';
import type { GrowthKpiSourceKind } from '../growth-source-of-record-adapters';

export class SyncGrowthSourceObservationsDto {
  @IsIn(['FINANCIAL_FACT', 'PRODUCTION_OUTPUT'])
  source_kind!: GrowthKpiSourceKind;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('4', { each: true })
  source_record_ids!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(8)
  @IsString({ each: true })
  @Matches(/^[a-z][a-z0-9_.-]{0,99}$/, { each: true })
  metric_keys!: string[];

  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/)
  idempotency_key!: string;
}
