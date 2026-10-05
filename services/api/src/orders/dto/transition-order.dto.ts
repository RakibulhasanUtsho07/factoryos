import {
  IsIn,
  IsInt,
  IsOptional,
  Min,
} from 'class-validator';

export const ORDER_STATUSES = [
  'DRAFT',
  'CONFIRMED',
  'IN_PROGRESS',
  'COMPLETED',
  'CANCELLED',
] as const;

export type OrderStatus =
  (typeof ORDER_STATUSES)[number];

export class TransitionOrderDto {
  @IsIn(ORDER_STATUSES)
  target_status!: OrderStatus;

  /**
   * Client's last known aggregate version.
   *
   * When supplied, the transition succeeds only
   * when the current order version matches it.
   */
  @IsOptional()
  @IsInt()
  @Min(1)
  expected_version?: number;
}