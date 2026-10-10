import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export enum GrowthOpportunityCategory {
  REVENUE_GROWTH = 'REVENUE_GROWTH',
  MARGIN_EXPANSION = 'MARGIN_EXPANSION',
  PRODUCT_MIX = 'PRODUCT_MIX',
  CUSTOMER_EXPANSION = 'CUSTOMER_EXPANSION',
  MARKET_CHANNEL_EXPANSION = 'MARKET_CHANNEL_EXPANSION',
  CAPACITY_UNLOCK = 'CAPACITY_UNLOCK',
  COST_REDUCTION = 'COST_REDUCTION',
  WORKING_CAPITAL = 'WORKING_CAPITAL',
  RISK_REDUCTION = 'RISK_REDUCTION',
}

export enum GrowthEvidenceKind {
  PRIVATE_OPERATIONAL = 'PRIVATE_OPERATIONAL',
  PRIVATE_FINANCIAL = 'PRIVATE_FINANCIAL',
  EXTERNAL_RESEARCH = 'EXTERNAL_RESEARCH',
}

export enum GrowthNodeType {
  CBB_NODE = 'CBB_NODE',
  BUSINESS_MODEL = 'BUSINESS_MODEL',
  PROCESS = 'PROCESS',
  KPI = 'KPI',
}

export enum GrowthUncertaintyLevel {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  UNKNOWN = 'UNKNOWN',
}

export enum GrowthEffortUnit {
  PERSON_HOURS = 'PERSON_HOURS',
  PERSON_DAYS = 'PERSON_DAYS',
  PERSON_WEEKS = 'PERSON_WEEKS',
}

export enum GrowthTimeToImpact {
  IMMEDIATE = 'IMMEDIATE',
  NEAR_TERM = 'NEAR_TERM',
  STRATEGIC = 'STRATEGIC',
}

export enum GrowthRiskClass {
  OPERATIONAL = 'OPERATIONAL',
  FINANCIAL = 'FINANCIAL',
  COMPLIANCE = 'COMPLIANCE',
  STRATEGIC = 'STRATEGIC',
}

export class GrowthOpportunityEvidenceDto {
  @IsEnum(GrowthEvidenceKind)
  kind!: GrowthEvidenceKind;

  @IsString()
  @MaxLength(200)
  label!: string;

  @ValidateIf((item: GrowthOpportunityEvidenceDto) => item.kind !== GrowthEvidenceKind.EXTERNAL_RESEARCH)
  @IsString()
  @MaxLength(255)
  reference_id!: string;

  @ValidateIf((item: GrowthOpportunityEvidenceDto) => item.kind === GrowthEvidenceKind.EXTERNAL_RESEARCH)
  @IsUUID()
  claim_id!: string;

  @ValidateIf((item: GrowthOpportunityEvidenceDto) => item.kind === GrowthEvidenceKind.EXTERNAL_RESEARCH)
  @IsUUID()
  evidence_id!: string;

  @ValidateIf((item: GrowthOpportunityEvidenceDto) => item.kind === GrowthEvidenceKind.EXTERNAL_RESEARCH)
  @IsString()
  @Matches(/^[a-fA-F0-9]{64}$/)
  content_sha256!: string;
}

export class GrowthAffectedNodeDto {
  @IsEnum(GrowthNodeType)
  node_type!: GrowthNodeType;

  @IsString()
  @MaxLength(200)
  node_ref!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  label?: string;
}

export class GrowthUncertaintyDto {
  @IsEnum(GrowthUncertaintyLevel)
  level!: GrowthUncertaintyLevel;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  limitations!: string[];

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  sensitivity_factors!: string[];

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  evidence_gaps!: string[];
}

export class CreateGrowthOpportunityDto {
  @IsString()
  @MaxLength(180)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,179}$/)
  opportunity_key!: string;

  @IsString()
  @MaxLength(60)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,59}$/)
  opportunity_version!: string;

  @IsEnum(GrowthOpportunityCategory)
  category!: GrowthOpportunityCategory;

  @IsString()
  @MaxLength(4000)
  statement!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => GrowthOpportunityEvidenceDto)
  evidence!: GrowthOpportunityEvidenceDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  assumptions!: string[];

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => GrowthAffectedNodeDto)
  affected_nodes!: GrowthAffectedNodeDto[];

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-1000000000000000)
  @Max(1000000000000000)
  expected_value_min!: number;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(-1000000000000000)
  @Max(1000000000000000)
  expected_value_max!: number;

  @IsString()
  @MaxLength(100)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/)
  expected_value_metric!: string;

  @IsString()
  @MaxLength(40)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._/%-]{0,39}$/)
  expected_value_unit!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/)
  expected_value_currency!: string;

  @ValidateNested()
  @Type(() => GrowthUncertaintyDto)
  uncertainty!: GrowthUncertaintyDto;

  @IsNumber({ allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(100000000)
  effort_estimate!: number;

  @IsEnum(GrowthEffortUnit)
  effort_unit!: GrowthEffortUnit;

  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  @MaxLength(200, { each: true })
  dependencies!: string[];

  @IsEnum(GrowthTimeToImpact)
  time_to_impact!: GrowthTimeToImpact;

  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  impact_date_assumption?: string;

  @IsEnum(GrowthRiskClass)
  risk_class!: GrowthRiskClass;

  @IsString()
  @MaxLength(4000)
  validation_plan!: string;

  @IsString()
  @MaxLength(100)
  @Matches(/^[A-Z][A-Z0-9_.:-]{1,99}$/)
  decision_owner_role!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
