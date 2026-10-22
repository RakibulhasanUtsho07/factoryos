import { Type } from 'class-transformer';
import { IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, Matches } from 'class-validator';

export const UTILITY_VENDOR_ADAPTERS = ['REST_POLL','OPC_UA','MQTT','MODBUS','FILE_IMPORT','MANUAL_IMPORT'] as const;
export const UTILITY_THRESHOLD_METRICS = ['CONSUMPTION','COST','INTENSITY'] as const;
export const UTILITY_THRESHOLD_COMPARISONS = ['GT','GTE','LT','LTE'] as const;
export const UTILITY_BINDING_ACTIONS = ['ACTIVATE','DEACTIVATE','RETIRE'] as const;

export class CreateUtilitySourceBindingDto {
  @IsString() @MaxLength(100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) source_system_code!: string;
  @IsString() @MaxLength(160) source_meter_code!: string;
  @IsIn([...UTILITY_VENDOR_ADAPTERS]) vendor_adapter!: typeof UTILITY_VENDOR_ADAPTERS[number];
  @IsUUID() meter_id!: string;
  @IsString() @MaxLength(24) source_unit_code!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0.00000001) factor_to_meter_unit = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(5) @Max(86400) polling_interval_seconds?: number;
  @IsOptional() @IsString() @MaxLength(255) credential_reference?: string;
  @IsOptional() @IsObject() config_metadata?: Record<string, unknown>;
}

export class TransitionUtilitySourceBindingDto {
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsIn([...UTILITY_BINDING_ACTIONS]) action!: typeof UTILITY_BINDING_ACTIONS[number];
  @IsString() @MaxLength(2000) reason!: string;
}

export class IngestUtilitySourceEventDto {
  @IsString() @MaxLength(100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) source_system_code!: string;
  @IsString() @MaxLength(160) source_meter_code!: string;
  @IsString() @MaxLength(160) source_event_id!: string;
  @IsDateString() reading_at!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0) reading_value!: number;
  @IsString() @MaxLength(24) source_unit_code!: string;
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0.00000001) production_quantity?: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class CreateUtilityThresholdPolicyDto {
  @IsString() @MaxLength(100) @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]*$/) policy_code!: string;
  @IsString() @MaxLength(255) name!: string;
  @IsOptional() @IsUUID() meter_id?: string;
  @IsOptional() @IsIn(['ELECTRICITY','GAS','STEAM','WATER','COMPRESSED_AIR','FUEL','OTHER'])
  utility_type?: 'ELECTRICITY'|'GAS'|'STEAM'|'WATER'|'COMPRESSED_AIR'|'FUEL'|'OTHER';
  @IsIn([...UTILITY_THRESHOLD_METRICS]) metric!: typeof UTILITY_THRESHOLD_METRICS[number];
  @IsIn([...UTILITY_THRESHOLD_COMPARISONS]) comparison!: typeof UTILITY_THRESHOLD_COMPARISONS[number];
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 8 }) @Min(0) threshold_value!: number;
  @IsString() @MaxLength(24) threshold_unit_code!: string;
  @IsIn(['LOW','MEDIUM','HIGH','CRITICAL']) severity!: 'LOW'|'MEDIUM'|'HIGH'|'CRITICAL';
}

export class TransitionUtilityThresholdPolicyDto {
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsIn(['ACTIVATE','DEACTIVATE','RETIRE']) action!: 'ACTIVATE'|'DEACTIVATE'|'RETIRE';
  @IsString() @MaxLength(2000) reason!: string;
}
