import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const INVENTORY_CYCLE_COUNT_VARIANCE_REASON_CODES = [
  'DAMAGE',
  'LOSS',
  'FOUND_STOCK',
  'OTHER',
] as const;

export type InventoryCycleCountVarianceReasonCode =
  (typeof INVENTORY_CYCLE_COUNT_VARIANCE_REASON_CODES)[number];

export class CreateInventoryCycleCountDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(99999999999999)
  counted_quantity!: number;

  @IsOptional()
  @IsUUID()
  location_id?: string;

  @IsOptional()
  @IsUUID()
  task_id?: string;

  @IsOptional()
  @IsIn(INVENTORY_CYCLE_COUNT_VARIANCE_REASON_CODES)
  variance_reason_code?: InventoryCycleCountVarianceReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
