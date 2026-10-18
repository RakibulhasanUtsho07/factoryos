import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDateString, IsIn, IsInt, IsNumber, IsObject,
  IsOptional, IsString, IsUUID, ValidateNested, Max, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const QUALITY_INSPECTION_TYPES = ['INCOMING', 'IN_PROCESS', 'FINAL', 'INVENTORY', 'SUPPLIER'] as const;
export const QUALITY_TARGET_TYPES = [
  'INVENTORY_ITEM', 'TRACEABILITY_UNIT', 'GOODS_RECEIPT_LINE', 'PRODUCTION_REPORT', 'WORK_ORDER',
] as const;
export const QUALITY_DEFECT_SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'] as const;
export const QUALITY_DECISION_ACTIONS = ['START', 'PASS', 'FAIL', 'HOLD', 'CANCEL'] as const;
export const QUALITY_DISPOSITION_ACTIONS = ['RELEASE', 'USE_AS_IS', 'REWORK', 'SCRAP', 'RETURN_TO_SUPPLIER'] as const;
export const QUALITY_NCR_ACTION_TYPES = ['CONTAINMENT', 'CORRECTIVE', 'PREVENTIVE'] as const;

export class CreateQualityInspectionDto {
  @IsIn([...QUALITY_INSPECTION_TYPES])
  inspection_type!: (typeof QUALITY_INSPECTION_TYPES)[number];

  @IsIn([...QUALITY_TARGET_TYPES])
  target_type!: (typeof QUALITY_TARGET_TYPES)[number];

  @IsUUID()
  target_id!: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  plan_code?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  sample_quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class CreateQualityDefectDto {
  @IsString()
  @MaxLength(100)
  defect_code!: string;

  @IsIn([...QUALITY_DEFECT_SEVERITIES])
  severity!: (typeof QUALITY_DEFECT_SEVERITIES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  affected_quantity?: number;

  @IsString()
  @MaxLength(4000)
  description!: string;

  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;
}

export class QualityInspectionDecisionDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsIn([...QUALITY_DECISION_ACTIONS])
  action!: (typeof QUALITY_DECISION_ACTIONS)[number];

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class QualityDispositionDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsIn([...QUALITY_DISPOSITION_ACTIONS])
  action!: (typeof QUALITY_DISPOSITION_ACTIONS)[number];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity?: number;

  @IsString()
  @MaxLength(2000)
  reason!: string;
}

export class CreateQualityNcrActionDto {
  @IsIn([...QUALITY_NCR_ACTION_TYPES])
  action_type!: (typeof QUALITY_NCR_ACTION_TYPES)[number];

  @IsString()
  @MaxLength(4000)
  action_text!: string;

  @IsOptional()
  @IsUUID()
  responsible_user_id?: string;

  @IsOptional()
  @IsDateString()
  due_date?: string;
}

export class CloseQualityNcrDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsString()
  @MaxLength(2000)
  reason!: string;
}

export class ListQualityInspectionsQueryDto {
  @IsOptional()
  @IsIn(['OPEN', 'IN_PROGRESS', 'PASSED', 'FAILED', 'ON_HOLD', 'DISPOSITIONED', 'CANCELLED'])
  status?: string;

  @IsOptional()
  @IsIn([...QUALITY_INSPECTION_TYPES])
  inspection_type?: string;

  @IsOptional()
  @IsIn([...QUALITY_TARGET_TYPES])
  target_type?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class QualityInspectionPlanCriterionDto {
  @IsString()
  @MaxLength(100)
  criterion_code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @IsIn(['NUMERIC', 'TEXT', 'BOOLEAN', 'ENUM'])
  value_type!: 'NUMERIC' | 'TEXT' | 'BOOLEAN' | 'ENUM';

  @IsIn(['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'BETWEEN', 'IN', 'CONTAINS'])
  comparison_operator!: 'EQ' | 'NE' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'BETWEEN' | 'IN' | 'CONTAINS';

  @IsOptional()
  @IsString()
  @MaxLength(255)
  target_value?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  lower_limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 6 })
  upper_limit?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  allowed_values?: string[];

  @IsOptional()
  @IsString()
  @MaxLength(50)
  unit?: string;

  @IsOptional()
  @IsBoolean()
  is_required?: boolean;

  @IsOptional()
  @IsBoolean()
  is_critical?: boolean;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  sequence_number?: number;
}

export class CreateQualityInspectionPlanDto {
  @IsString()
  @MaxLength(100)
  plan_code!: string;

  @IsString()
  @MaxLength(255)
  name!: string;

  @IsIn([...QUALITY_INSPECTION_TYPES])
  inspection_type!: (typeof QUALITY_INSPECTION_TYPES)[number];

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  default_sample_quantity?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => QualityInspectionPlanCriterionDto)
  criteria!: QualityInspectionPlanCriterionDto[];
}

export class QualityInspectionPlanTransitionDto {
  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsIn(['ACTIVATE', 'RETIRE'])
  action!: 'ACTIVATE' | 'RETIRE';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class CreateQualityInspectionResultDto {
  @IsString()
  @MaxLength(100)
  criterion_code!: string;

  @IsString()
  @MaxLength(1000)
  observed_value!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;
}

export class ListQualityPlansQueryDto {
  @IsOptional()
  @IsIn([...QUALITY_INSPECTION_TYPES])
  inspection_type?: string;

  @IsOptional()
  @IsIn(['DRAFT', 'ACTIVE', 'RETIRED'])
  status?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
