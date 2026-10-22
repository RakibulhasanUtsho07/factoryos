import {
  ArrayMaxSize, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional,
  IsString, Max, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

const inspectionTypes = ['INCOMING','IN_PROCESS','FINAL','INVENTORY','SUPPLIER'] as const;

export class CreateQualityAqlProfileDto {
  @IsString() @MaxLength(100) profile_code!: string;
  @IsIn([...inspectionTypes]) inspection_type!: (typeof inspectionTypes)[number];
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(100) aql_percent!: number;
  @IsIn(['S-1','S-2','S-3','S-4','I','II','III']) inspection_level!: string;
  @Type(() => Number) @IsInt() @Min(1) lot_size_min!: number;
  @Type(() => Number) @IsInt() @Min(1) lot_size_max!: number;
  @Type(() => Number) @IsInt() @Min(1) sample_size!: number;
  @Type(() => Number) @IsInt() @Min(0) accept_number!: number;
  @Type(() => Number) @IsInt() @Min(1) reject_number!: number;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class CreateFabricScoringProfileDto {
  @IsString() @MaxLength(100) profile_code!: string;
  @IsIn([...inspectionTypes]) inspection_type!: (typeof inspectionTypes)[number];
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) max_points_per_100_square_yards!: number;
  @Type(() => Number) @IsInt() @Min(1) @Max(10000) minimum_roll_count = 1;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}

export class QualityAdvancedProfileTransitionDto {
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsIn(['ACTIVATE','RETIRE']) action!: 'ACTIVATE' | 'RETIRE';
  @IsString() @MaxLength(2000) reason!: string;
}

export class BindQualitySamplingProfilesDto {
  @Type(() => Number) @IsInt() @Min(1) expected_version!: number;
  @IsOptional() @IsString() @MaxLength(100) aql_profile_code?: string;
  @IsOptional() @IsString() @MaxLength(100) fabric_scoring_profile_code?: string;
}

export class RecordQualityAqlSampleDto {
  @Type(() => Number) @IsInt() @Min(1) lot_size!: number;
  @Type(() => Number) @IsInt() @Min(0) observed_nonconforming!: number;
  @IsOptional() @IsObject() evidence?: Record<string, unknown>;
}

export class RecordFabricRollScoreDto {
  @IsString() @MaxLength(120) roll_code!: string;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) roll_length_yards!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) roll_width_inches!: number;
  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) total_defect_points!: number;
  @IsArray() @ArrayMaxSize(1000) defects!: Record<string, unknown>[];
  @IsOptional() @IsObject() evidence?: Record<string, unknown>;
}

export class RecordQualityDefectContextDto {
  @IsOptional() @IsString() @MaxLength(100) line_code?: string;
  @IsOptional() @IsString() @MaxLength(100) operation_code?: string;
  @IsOptional() @IsString() @MaxLength(120) style_code?: string;
  @IsOptional() @IsString() @MaxLength(80) shift_code?: string;
  @IsOptional() @IsObject() evidence?: Record<string, unknown>;
}

export class QualityDefectParetoQueryDto {
  @IsIn(['DEFECT','LINE','OPERATION','STYLE','SHIFT']) dimension!: 'DEFECT'|'LINE'|'OPERATION'|'STYLE'|'SHIFT';
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class QualityRepeatAlertsQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365) lookback_days?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(2) @Max(10000) minimum_occurrences?: number;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}
