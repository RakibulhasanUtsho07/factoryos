import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsInt, IsNumber, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateNested } from 'class-validator';
import { GrowthOutcomeSourceSystem } from './record-growth-opportunity-outcome.dto';

export enum GrowthExperimentDecision { APPROVED='APPROVED', REJECTED='REJECTED', DEFERRED='DEFERRED', STARTED='STARTED', PAUSED='PAUSED', STOPPED='STOPPED', COMPLETED='COMPLETED' }
export enum GrowthExperimentMeasurementStage { BASELINE='BASELINE', PRE='PRE', POST='POST', REALIZED='REALIZED' }

export class GrowthExperimentDefinitionSectionDto {
 @IsString() @MaxLength(2000) description!: string;
 @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({each:true}) @MaxLength(500,{each:true}) design_rules?: string[];
 @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({each:true}) @MaxLength(500,{each:true}) guardrails?: string[];
}
export class GrowthExperimentSampleScopeDto {
 @IsString() @MaxLength(1000) description!: string;
 @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({each:true}) @MaxLength(200,{each:true}) factory_line_refs?: string[];
 @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({each:true}) @MaxLength(200,{each:true}) product_refs?: string[];
 @IsOptional() @IsArray() @ArrayMaxSize(100) @IsString({each:true}) @MaxLength(200,{each:true}) shift_refs?: string[];
 @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({each:true}) @MaxLength(500,{each:true}) inclusion_rules?: string[];
 @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({each:true}) @MaxLength(500,{each:true}) exclusion_rules?: string[];
}
export class CreateGrowthExperimentDto {
 @IsString() @MaxLength(180) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/) experiment_key!: string;
 @IsString() @MaxLength(60) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$/) experiment_version!: string;
 @IsOptional() @IsUUID() scenario_snapshot_id?: string;
 @IsString() @MaxLength(4000) hypothesis!: string;
 @IsString() @MaxLength(2000) objective!: string;
 @IsString() @MaxLength(100) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/) primary_metric!: string;
 @ValidateNested() @Type(()=>GrowthExperimentDefinitionSectionDto) baseline_definition!: GrowthExperimentDefinitionSectionDto;
 @ValidateNested() @Type(()=>GrowthExperimentDefinitionSectionDto) control_definition!: GrowthExperimentDefinitionSectionDto;
 @ValidateNested() @Type(()=>GrowthExperimentDefinitionSectionDto) treatment_definition!: GrowthExperimentDefinitionSectionDto;
 @IsInt() @Min(1) @Max(365) duration_days!: number;
 @IsString() @MaxLength(100) @Matches(/^[A-Z][A-Z0-9_.:-]{1,99}$/) owner_role!: string;
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({each:true}) @MaxLength(500,{each:true}) stop_conditions!: string[];
 @ValidateNested() @Type(()=>GrowthExperimentSampleScopeDto) sample_scope!: GrowthExperimentSampleScopeDto;
 @IsString() @MaxLength(128) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/) idempotency_key!: string;
}
export class RecordGrowthExperimentDecisionDto {
 @IsEnum(GrowthExperimentDecision) decision!: GrowthExperimentDecision;
 @IsString() @MaxLength(2000) rationale!: string;
 @IsString() @MaxLength(128) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/) idempotency_key!: string;
}
export class RecordGrowthExperimentMeasurementDto {
 @IsEnum(GrowthExperimentMeasurementStage) measurement_stage!: GrowthExperimentMeasurementStage;
 @IsString() @MaxLength(100) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/) metric_key!: string;
 @IsNumber({allowNaN:false,allowInfinity:false}) @Min(-1000000000000000) @Max(1000000000000000) actual_value!: number;
 @IsString() @MaxLength(40) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._/%-]{0,39}$/) metric_unit!: string;
 @IsDateString() observed_at!: string;
 @IsEnum(GrowthOutcomeSourceSystem) source_system!: GrowthOutcomeSourceSystem;
 @IsString() @MaxLength(255) source_record_ref!: string;
 @IsOptional() @IsString() @Matches(/^[a-fA-F0-9]{64}$/) source_snapshot_sha256?: string;
 @IsString() @MaxLength(128) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/) idempotency_key!: string;
}
