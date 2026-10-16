import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export const STOCK_RECONCILIATION_REASON_CODES = [
  'CYCLE_COUNT',
  'DAMAGE',
  'LOSS',
  'FOUND_STOCK',
  'OPENING_BALANCE',
  'OTHER',
] as const;

export type StockReconciliationReasonCode =
  (typeof STOCK_RECONCILIATION_REASON_CODES)[number];

export class CreateInventoryStockReconciliationDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  @Max(99999999999999)
  counted_quantity!: number;

  @IsIn(STOCK_RECONCILIATION_REASON_CODES)
  reason_code!: StockReconciliationReasonCode;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
