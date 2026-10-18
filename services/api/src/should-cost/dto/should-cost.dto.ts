import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNotEmpty,
  IsNumber, IsObject, IsOptional, IsString, IsUUID, Max, MaxLength, Min, ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import {
  SHOULD_COST_CATEGORIES,
  type ShouldCostCategory,
  type ShouldCostMethod,
} from '../should-cost-engine';

export const SHOULD_COST_METHODS: ShouldCostMethod[] = [
  'DIRECT_RATE', 'FIXED_PER_BATCH', 'PERCENT_OF_BASE', 'SCRAP_GROSS_UP',
];
export const SHOULD_COST_SOURCE_TYPES = [
  'SUPPLIER_QUOTE', 'PURCHASE_ORDER', 'COST_RATE_CARD', 'UTILITY_BILL',
  'FREIGHT_QUOTE', 'DUTY_SCHEDULE', 'OVERHEAD_POLICY', 'QUALITY_STANDARD',
  'MANUAL_APPROVED',
] as const;
export const SHOULD_COST_QUANTITY_SOURCE_TYPES = [
  'BOM', 'ROUTING', 'UTILITY_READING', 'MANUAL_APPROVED',
] as const;
export const SHOULD_COST_SCOPE_TYPES = ['PRODUCT_VERSION', 'ORDER', 'QUOTATION'] as const;

export class ShouldCostProfileComponentDto {
  @IsIn(SHOULD_COST_CATEGORIES)
  category!: ShouldCostCategory;

  @IsIn(SHOULD_COST_METHODS)
  calculation_method!: ShouldCostMethod;

  @IsBoolean()
  is_required = true;

  @IsArray()
  @ArrayMaxSize(6)
  @IsIn(SHOULD_COST_CATEGORIES, { each: true })
  base_categories: ShouldCostCategory[] = [];

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  guidance!: string;
}

export class CreateShouldCostProfileDto {
  @IsUUID()
  factory_id!: string;

  @IsOptional()
  @IsUUID()
  product_id?: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  profile_code!: string;

  @IsString()
  @MaxLength(3)
  currency = 'BDT';

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  output_unit!: string;

  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  @ValidateNested({ each: true })
  @Type(() => ShouldCostProfileComponentDto)
  components!: ShouldCostProfileComponentDto[];
}

export class TransitionShouldCostProfileDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

export class ShouldCostEvidenceDto {
  @IsIn(SHOULD_COST_CATEGORIES)
  category!: ShouldCostCategory;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  line_number!: number;

  @IsBoolean()
  applicable = true;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0)
  @Max(999999999999)
  input_quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit_code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 8 })
  @Min(0)
  @Max(999999999999)
  unit_rate?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(9999999999999999)
  fixed_amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(100)
  percentage_rate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(3)
  source_currency?: string;

  @ValidateIf((value: ShouldCostEvidenceDto) => value.applicable)
  @IsIn(SHOULD_COST_SOURCE_TYPES)
  source_type!: (typeof SHOULD_COST_SOURCE_TYPES)[number] | 'NOT_APPLICABLE';

  @ValidateIf((value: ShouldCostEvidenceDto) => value.applicable)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  source_reference?: string;

  @ValidateIf((value: ShouldCostEvidenceDto) => value.applicable)
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  source_as_of!: string;

  @IsOptional()
  @IsIn(SHOULD_COST_QUANTITY_SOURCE_TYPES)
  quantity_source_type?: (typeof SHOULD_COST_QUANTITY_SOURCE_TYPES)[number];

  @IsOptional()
  @IsString()
  @MaxLength(500)
  quantity_source_reference?: string;

  @IsOptional()
  @IsObject()
  quantity_source_snapshot?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  source_snapshot?: Record<string, unknown>;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  notes!: string;
}

export class CreateShouldCostAssessmentDto {
  @IsIn(SHOULD_COST_SCOPE_TYPES)
  scope_type!: (typeof SHOULD_COST_SCOPE_TYPES)[number];

  @IsUUID()
  target_id!: string;

  @IsUUID()
  profile_id!: string;

  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(99999999999999)
  target_quantity!: number;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  target_unit!: string;

  @IsArray()
  @ArrayMinSize(7)
  @ArrayMaxSize(1000)
  @ValidateNested({ each: true })
  @Type(() => ShouldCostEvidenceDto)
  evidence!: ShouldCostEvidenceDto[];
}

export class ListShouldCostProfilesDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  profile_code?: string;

  @IsOptional()
  @IsUUID()
  product_id?: string;

  @IsOptional()
  @IsIn(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED'])
  status?: 'DRAFT' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
}

export class ListShouldCostAssessmentsDto {
  @IsOptional()
  @IsIn(SHOULD_COST_SCOPE_TYPES)
  scope_type?: (typeof SHOULD_COST_SCOPE_TYPES)[number];

  @IsOptional()
  @IsUUID()
  target_id?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit = 20;
}
