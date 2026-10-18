import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsNumber,
  IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';

export const UTILITY_TYPES = ['ELECTRICITY','GAS','STEAM','WATER','COMPRESSED_AIR','FUEL','OTHER'] as const;
export const UTILITY_READING_MODES = ['CUMULATIVE','INTERVAL'] as const;
export const UTILITY_READING_SOURCES = ['MANUAL','API','METER_GATEWAY','IMPORT'] as const;
export const UTILITY_EVENT_TYPES = ['OUTAGE','PEAK_LOAD','LEAK','PRESSURE_DROP','METER_FAULT','EFFICIENCY_EXCEPTION','OTHER'] as const;
export const UTILITY_SEVERITIES = ['LOW','MEDIUM','HIGH','CRITICAL'] as const;
export const UTILITY_EVENT_ACTIONS = ['ACKNOWLEDGE','RESOLVE','CANCEL'] as const;

export class CreateUtilityMeterDto {
  @IsString() @MaxLength(100) meter_code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsIn([...UTILITY_TYPES]) utility_type!: typeof UTILITY_TYPES[number];
  @IsIn([...UTILITY_READING_MODES]) reading_mode!: typeof UTILITY_READING_MODES[number];
  @IsString() @MaxLength(24) unit_code!: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0.00000001) multiplier_factor?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0) unit_cost?: number;
  @IsOptional() @IsString() @MaxLength(3) currency_code?: string;
  @IsOptional() @IsString() @MaxLength(100) cost_center_code?: string;
  @IsOptional() @IsString() @MaxLength(100) source_system_code?: string;
  @IsOptional() @IsString() @MaxLength(255) location?: string;
  @IsOptional() @IsUUID() parent_meter_id?: string;
}

export class RecordUtilityReadingDto {
  @IsDateString() reading_at!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0) reading_value!: number;
  @IsIn([...UTILITY_READING_SOURCES]) source_type!: typeof UTILITY_READING_SOURCES[number];
  @IsOptional() @IsString() @MaxLength(255) source_event_id?: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0.00000001) production_quantity?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class ListUtilityReadingsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

export class ListUtilityMetersQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) limit?: number;
  @IsOptional() @IsIn([...UTILITY_TYPES]) utility_type?: typeof UTILITY_TYPES[number];
  @IsOptional() @IsIn(['ACTIVE','INACTIVE','RETIRED']) status?: 'ACTIVE'|'INACTIVE'|'RETIRED';
}

export class CreateUtilityEventDto {
  @IsOptional() @IsUUID() meter_id?: string;
  @IsIn([...UTILITY_EVENT_TYPES]) event_type!: typeof UTILITY_EVENT_TYPES[number];
  @IsIn([...UTILITY_SEVERITIES]) severity!: typeof UTILITY_SEVERITIES[number];
  @IsString() @MaxLength(255) title!: string;
  @IsString() @MaxLength(4000) description!: string;
  @IsDateString() occurred_at!: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440) impact_minutes?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0) impact_quantity?: number;
  @IsOptional() @IsString() @MaxLength(2000) cause?: string;
}

export class TransitionUtilityEventDto {
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsIn([...UTILITY_EVENT_ACTIONS]) action!: typeof UTILITY_EVENT_ACTIONS[number];
  @IsString() @MaxLength(2000) reason!: string;
  @IsOptional() @IsString() @MaxLength(4000) resolution?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1440) impact_minutes?: number;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0) impact_quantity?: number;
}
