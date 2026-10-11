import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export enum GrowthOutcomeStage {
  BASELINE = 'BASELINE',
  PRE = 'PRE',
  POST = 'POST',
  REALIZED = 'REALIZED',
}

export enum GrowthOutcomeSourceSystem {
  ERP = 'ERP',
  MES = 'MES',
  CRM = 'CRM',
  FINANCE = 'FINANCE',
  QUALITY = 'QUALITY',
  MAINTENANCE = 'MAINTENANCE',
  OTHER = 'OTHER',
}

export class RecordGrowthOpportunityOutcomeDto {
  @IsEnum(GrowthOutcomeStage)
  measurement_stage!: GrowthOutcomeStage;

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/)
  metric_key!: string;

  @Type(() => Number)
  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-1000000000000000)
  @Max(1000000000000000)
  actual_value!: number;

  @IsString()
  @MaxLength(40)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._/%-]{0,39}$/)
  metric_unit!: string;

  @IsDateString()
  observed_at!: string;

  @IsEnum(GrowthOutcomeSourceSystem)
  source_system!: GrowthOutcomeSourceSystem;

  @IsString()
  @MaxLength(255)
  source_record_ref!: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  source_snapshot_sha256?: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
