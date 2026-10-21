import { IsIn, IsNumber, IsOptional, Max, MaxLength, Min } from 'class-validator';

export class TransitionInventoryReservationDto {
  @IsIn(['RELEASED', 'CONSUMED'])
  target_status!: 'RELEASED' | 'CONSUMED';

  /**
   * Optional bounded partial issue quantity. Omitted means consume all outstanding
   * reserved quantity for compatibility with existing callers. It is not valid for
   * RELEASED; release remains an explicit terminal decision for the remaining stock.
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(99999999999999)
  quantity?: number;
}
