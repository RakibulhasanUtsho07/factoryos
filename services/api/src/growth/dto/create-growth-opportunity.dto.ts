import { Type } from 'class-transformer';
import {
  ArrayMinSize, IsArray, IsIn, IsInt, IsNotEmpty, IsNumber, IsObject,
  IsOptional, IsString, IsUUID, Max, MaxLength, Min, MinLength, ValidateNested,
} from 'class-validator';
import { CreateOpportunityEvidenceDto } from './create-opportunity-evidence.dto';

export class CreateGrowthOpportunityDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title!: string;

  @IsIn([
    'REVENUE_GROWTH', 'MARGIN_EXPANSION', 'PRODUCT_MIX', 'CUSTOMER_EXPANSION',
    'MARKET_CHANNEL_EXPANSION', 'CAPACITY_UNLOCK', 'COST_REDUCTION',
    'WORKING_CAPITAL', 'RISK_REDUCTION', 'RESILIENCE', 'EXPORT_READINESS',
  ])
  category!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  opportunity_statement!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  success_hypothesis!: string;

  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @MinLength(5, { each: true })
  @MaxLength(2000, { each: true })
  assumptions!: string[];

  @IsOptional()
  @IsObject()
  constraints_snapshot?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsUUID(undefined, { each: true })
  affected_business_nodes?: string[];

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-1000000000000)
  @Max(1000000000000)
  expected_value_low!: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(-1000000000000)
  @Max(1000000000000)
  expected_value_high!: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  uncertainty_pct!: number;

  @IsIn(['SMALL', 'MEDIUM', 'LARGE', 'UNKNOWN'])
  effort!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  time_to_impact_days!: number;

  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'])
  implementation_risk!: string;

  @IsOptional()
  @IsUUID()
  owner_user_id?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateOpportunityEvidenceDto)
  evidence!: CreateOpportunityEvidenceDto[];
}
