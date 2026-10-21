import {
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export const CYCLE_COUNT_VARIANCE_REASON_CODES = [
  'COUNTING_ERROR',
  'DAMAGE',
  'LOSS',
  'FOUND_STOCK',
  'RECEIPT_ERROR',
  'PICKING_ERROR',
  'OTHER',
] as const;

export type CycleCountVarianceReasonCode =
  (typeof CYCLE_COUNT_VARIANCE_REASON_CODES)[number];

export class ReviewInventoryCycleCountDto {
  /**
   * Required when the physical count differs from the captured ledger balance.
   * Optional only for a zero-variance count; validated against the locked balance
   * inside the approval transaction.
   */
  @IsOptional()
  @IsIn(CYCLE_COUNT_VARIANCE_REASON_CODES)
  variance_reason_code?: CycleCountVarianceReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  review_note?: string;
}
