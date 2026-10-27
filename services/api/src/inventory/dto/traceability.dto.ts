import {
  ArrayUnique, IsArray, IsDateString, IsIn, IsInt, IsNumber, IsObject, IsOptional,
  IsString, IsUUID, Matches, Max, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';

export const TRACEABILITY_UNIT_TYPES = [
  'LOT', 'SERIAL', 'PALLET', 'CARTON', 'BUNDLE', 'FINISHED_GOOD', 'SHIPMENT',
] as const;
export const TRACEABILITY_PRODUCT_ROLES = [
  'MATERIAL', 'FINISHED_GOOD', 'PACKAGING', 'SHIPMENT', 'OTHER',
] as const;
export const TRACEABILITY_LABEL_TARGET_TYPES = [
  ...TRACEABILITY_UNIT_TYPES, 'MATERIAL',
] as const;
export const TRACEABILITY_STATUSES = [
  'ACTIVE', 'QUARANTINED', 'RECALLED', 'DISPOSED', 'SHIPPED',
] as const;
export const GENEALOGY_RELATIONSHIP_TYPES = [
  'CONSUMED_INTO', 'PROCESSED_INTO', 'SPLIT_INTO', 'MERGED_INTO',
  'PACKED_INTO', 'SHIPPED_AS', 'REWORKED_INTO',
] as const;

export class CreateTraceabilityUnitDto {
  @IsIn([...TRACEABILITY_UNIT_TYPES])
  unit_type!: (typeof TRACEABILITY_UNIT_TYPES)[number];
  @IsIn([...TRACEABILITY_PRODUCT_ROLES])
  product_role!: (typeof TRACEABILITY_PRODUCT_ROLES)[number];
  @IsString()
  @MaxLength(160)
  unit_code!: string;
  @IsOptional()
  @IsString()
  @MaxLength(255)
  barcode_value?: string;
  @IsOptional()
  @IsString()
  @Matches(/^[A-Z0-9._:-]{1,128}$/i)
  @MaxLength(128)
  rfid_epc?: string;
  @IsOptional()
  @IsUUID()
  inventory_item_id?: string;
  @IsOptional()
  @IsUUID()
  goods_receipt_line_id?: string;
  @IsOptional()
  @IsUUID()
  order_id?: string;
  @IsOptional()
  @IsUUID()
  order_line_id?: string;
  @IsOptional()
  @IsUUID()
  production_report_id?: string;
  @IsOptional()
  @IsUUID()
  label_template_id?: string;
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity!: number;
  @IsString()
  @MaxLength(50)
  unit!: string;
  @IsOptional()
  @IsString()
  @MaxLength(255)
  external_reference?: string;
  @IsOptional()
  @IsDateString()
  manufactured_at?: string;
  @IsOptional()
  @IsDateString()
  expires_at?: string;
  @IsOptional()
  @IsObject()
  attributes?: Record<string, unknown>;
}

export class CreateGenealogyEventDto {
  @IsUUID()
  source_unit_id!: string;
  @IsUUID()
  target_unit_id!: string;
  @IsIn([...GENEALOGY_RELATIONSHIP_TYPES])
  relationship_type!: (typeof GENEALOGY_RELATIONSHIP_TYPES)[number];
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity!: number;
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
  @IsOptional()
  @IsObject()
  evidence?: Record<string, unknown>;
}

export class ChangeTraceabilityUnitStatusDto {
  @IsIn([...TRACEABILITY_STATUSES])
  target_status!: (typeof TRACEABILITY_STATUSES)[number];
  @IsString()
  @MaxLength(2000)
  reason!: string;
}

export class CreateTraceabilityLabelTemplateDto {
  @IsString()
  @MaxLength(100)
  template_code!: string;
  @IsString()
  @MaxLength(255)
  name!: string;
  @IsIn(['QR', 'CODE128', 'DATAMATRIX', 'GS1_128', 'GS1_DATAMATRIX'])
  symbology!: 'QR' | 'CODE128' | 'DATAMATRIX' | 'GS1_128' | 'GS1_DATAMATRIX';
  @IsArray()
  @ArrayUnique()
  @IsIn([...TRACEABILITY_LABEL_TARGET_TYPES], { each: true })
  supported_unit_types!: Array<(typeof TRACEABILITY_LABEL_TARGET_TYPES)[number]>;
  @IsOptional()
  @IsObject()
  label_layout?: Record<string, unknown>;
}

export class UpdateTraceabilitySettingsDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  expected_version!: number;
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  retention_years?: number;
  @IsOptional()
  @IsIn(['FIFO', 'FEFO', 'LOT', 'SERIAL'])
  allocation_policy?: 'FIFO' | 'FEFO' | 'LOT' | 'SERIAL';
}

export class UpdateInventoryItemAllocationPolicyDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expected_version!: number;

  @IsIn(['FIFO', 'FEFO', 'LOT', 'SERIAL'])
  allocation_policy!: 'FIFO' | 'FEFO' | 'LOT' | 'SERIAL';
}

export class IssueTraceabilityLabelDto {
  @IsOptional()
  @IsUUID()
  unit_id?: string;

  @IsOptional()
  @IsUUID()
  item_id?: string;

  @IsUUID()
  template_id!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  copy_count?: number;
}

export class ResolveTraceabilityLabelDto {
  @IsString()
  @MaxLength(255)
  code!: string;
}

/**
 * A recall declaration must operate on a complete bounded genealogy. The service
 * refuses the request rather than changing a partial set when either bound is hit.
 */
export class CreateRecallNotificationIntentDto {
  @IsIn(['CUSTOMER', 'SITE'])
  recipient_type!: 'CUSTOMER' | 'SITE';

  @IsString()
  @MaxLength(255)
  recipient_reference!: string;

  @IsIn(['EMAIL', 'PORTAL', 'EDI', 'MANUAL'])
  channel!: 'EMAIL' | 'PORTAL' | 'EDI' | 'MANUAL';

  @IsOptional()
  @IsString()
  @MaxLength(1800)
  reason?: string;
}

export class RecordRecallNotificationAcknowledgementDto {
  @IsIn(['RECEIVED', 'NO_ACTION_REQUIRED', 'ACTION_IN_PROGRESS', 'ACTION_COMPLETED', 'UNABLE_TO_CONFIRM'])
  outcome!: 'RECEIVED' | 'NO_ACTION_REQUIRED' | 'ACTION_IN_PROGRESS' | 'ACTION_COMPLETED' | 'UNABLE_TO_CONFIRM';

  @IsOptional()
  @IsString()
  @MaxLength(1800)
  notes?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  evidence_reference?: string;
}

export class DeclareTraceabilityRecallDto {
  @IsString()
  @MaxLength(1800)
  reason!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  depth?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}
