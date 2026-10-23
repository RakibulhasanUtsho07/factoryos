import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum EdgeRuntimeHealthStatus {
  HEALTHY = 'HEALTHY',
  DEGRADED = 'DEGRADED',
  NEEDS_ATTENTION = 'NEEDS_ATTENTION',
}

export enum EdgeDriftSignalType {
  INPUT_DRIFT = 'INPUT_DRIFT',
  OUTPUT_DRIFT = 'OUTPUT_DRIFT',
  LOW_CONFIDENCE = 'LOW_CONFIDENCE',
  PERFORMANCE_REGRESSION = 'PERFORMANCE_REGRESSION',
  EVALUATION_REQUIRED = 'EVALUATION_REQUIRED',
}

export enum EdgeDriftSeverity {
  INFO = 'INFO',
  WARNING = 'WARNING',
  CRITICAL = 'CRITICAL',
}

export class EdgeDriftSignalDto {
  @IsUUID()
  signal_id!: string;

  @IsString()
  @MaxLength(80)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/)
  model_key!: string;

  @IsEnum(EdgeDriftSignalType)
  signal_type!: EdgeDriftSignalType;

  @IsEnum(EdgeDriftSeverity)
  severity!: EdgeDriftSeverity;

  @IsDateString()
  detected_at!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  observed_score?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(1)
  baseline_score?: number;
}

export class EdgeDeviceHealthReportDto {
  @IsUUID()
  health_event_id!: string;

  @IsDateString()
  reported_at!: string;

  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/)
  agent_version!: string;

  @IsEnum(EdgeRuntimeHealthStatus)
  runtime_status!: EdgeRuntimeHealthStatus;

  @IsInt()
  @Min(0)
  @Max(10000)
  pending_batches!: number;

  @IsInt()
  @Min(0)
  @Max(4294967296)
  pending_bytes!: number;

  @IsOptional()
  @IsDateString()
  last_successful_sync_at?: string | null;

  @IsObject()
  model_versions!: Record<string, string>;

  @IsArray()
  @ArrayMaxSize(32)
  @ValidateNested({ each: true })
  @Type(() => EdgeDriftSignalDto)
  drift_signals!: EdgeDriftSignalDto[];

  @IsObject()
  capabilities!: Record<string, unknown>;
}
