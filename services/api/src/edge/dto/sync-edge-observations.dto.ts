import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsObject,
  IsOptional,
  IsInt,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export enum EdgeObservationSourceMode {
  EDGE_OFFLINE = 'EDGE_OFFLINE',
  CLOUD_CONNECTED = 'CLOUD_CONNECTED',
}

export enum EdgeObservationQuality {
  GOOD = 'GOOD',
  UNCERTAIN = 'UNCERTAIN',
  BAD = 'BAD',
}

export class EdgeObservationDto {
  @IsUUID()
  event_id!: string;

  @IsString()
  @MaxLength(120)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/)
  signal_key!: string;

  @IsDateString()
  observed_at!: string;

  @IsEnum(EdgeObservationSourceMode)
  source_mode!: EdgeObservationSourceMode;

  @IsEnum(EdgeObservationQuality)
  quality!: EdgeObservationQuality;

  /**
   * Optional on the cloud endpoint for backward-compatible replay of legacy
   * spool files; new local agent intake requires both stream metadata fields.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9%._/-]{1,32}$/)
  unit?: string;

  /** 0 means event-driven; positive values are periodic sampling intervals. */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(86400000)
  sampling_interval_ms?: number;

  @IsObject()
  payload!: Record<string, unknown>;
}

export class SyncEdgeObservationsDto {
  @IsString()
  @MaxLength(128)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  batch_key!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => EdgeObservationDto)
  observations!: EdgeObservationDto[];
}
