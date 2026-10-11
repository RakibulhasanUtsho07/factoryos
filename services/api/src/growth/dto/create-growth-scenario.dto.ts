import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsDateString, IsEnum, IsNumber, IsString, IsUUID, Matches, Max, MaxLength, Min, ValidateIf, ValidateNested } from 'class-validator';
import { GrowthUncertaintyDto } from './create-growth-opportunity.dto';

export enum GrowthScenarioType { BASE='BASE', UPSIDE='UPSIDE', DOWNSIDE='DOWNSIDE', STRESS='STRESS' }
export enum GrowthScenarioSourceSystem { ERP='ERP', MES='MES', CRM='CRM', FINANCE='FINANCE', QUALITY='QUALITY', MAINTENANCE='MAINTENANCE', RESEARCH='RESEARCH', OTHER='OTHER' }

export class GrowthScenarioSourceReferenceDto {
 @IsEnum(GrowthScenarioSourceSystem) source_system!: GrowthScenarioSourceSystem;
 @IsString() @MaxLength(255) source_record_ref!: string;
 @IsString() @Matches(/^[a-fA-F0-9]{64}$/) snapshot_sha256!: string;
 @ValidateIf((v: GrowthScenarioSourceReferenceDto)=>v.source_system===GrowthScenarioSourceSystem.RESEARCH) @IsUUID() claim_id?: string;
 @ValidateIf((v: GrowthScenarioSourceReferenceDto)=>v.source_system===GrowthScenarioSourceSystem.RESEARCH) @IsUUID() evidence_id?: string;
 @ValidateIf((v: GrowthScenarioSourceReferenceDto)=>v.source_system===GrowthScenarioSourceSystem.RESEARCH) @IsString() @Matches(/^[a-fA-F0-9]{64}$/) content_sha256?: string;
}
export class GrowthScenarioImpactBandDto {
 @IsString() @MaxLength(100) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/) metric!: string;
 @IsNumber({allowNaN:false,allowInfinity:false}) @Min(-1000000000000000) @Max(1000000000000000) min!: number;
 @IsNumber({allowNaN:false,allowInfinity:false}) @Min(-1000000000000000) @Max(1000000000000000) max!: number;
 @IsString() @MaxLength(40) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._/%-]{0,39}$/) unit!: string;
}
export class GrowthScenarioImpactBandsDto {
 @ValidateNested() @Type(()=>GrowthScenarioImpactBandDto) kpi!: GrowthScenarioImpactBandDto;
 @ValidateNested() @Type(()=>GrowthScenarioImpactBandDto) cash!: GrowthScenarioImpactBandDto;
 @ValidateNested() @Type(()=>GrowthScenarioImpactBandDto) margin!: GrowthScenarioImpactBandDto;
 @ValidateNested() @Type(()=>GrowthScenarioImpactBandDto) capacity!: GrowthScenarioImpactBandDto;
}
export class CreateGrowthScenarioDto {
 @IsString() @MaxLength(180) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/) scenario_key!: string;
 @IsString() @MaxLength(60) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$/) scenario_version!: string;
 @IsEnum(GrowthScenarioType) scenario_type!: GrowthScenarioType;
 @IsString() @MaxLength(120) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:+-]{0,119}$/) model_version!: string;
 @IsDateString() data_vintage_at!: string;
 @IsString() @Matches(/^[a-fA-F0-9]{64}$/) input_snapshot_sha256!: string;
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @ValidateNested({each:true}) @Type(()=>GrowthScenarioSourceReferenceDto) source_snapshot_refs!: GrowthScenarioSourceReferenceDto[];
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({each:true}) @MaxLength(500,{each:true}) assumptions!: string[];
 @ValidateNested() @Type(()=>GrowthScenarioImpactBandsDto) impact_bands!: GrowthScenarioImpactBandsDto;
 @IsArray() @ArrayMaxSize(100) @IsString({each:true}) @MaxLength(500,{each:true}) constraints_violated!: string[];
 @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsString({each:true}) @MaxLength(500,{each:true}) validation_questions!: string[];
 @ValidateNested() @Type(()=>GrowthUncertaintyDto) uncertainty!: GrowthUncertaintyDto;
 @IsString() @MaxLength(128) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/) idempotency_key!: string;
}
