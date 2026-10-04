import {
  IsIn,
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
  @IsIn(
    ORDER_STATUSES,
  )
  target_status!: OrderStatus;
}