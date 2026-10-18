import {
  IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional, IsString, IsUUID,
  Max, MaxLength, Min,
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
