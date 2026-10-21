import { IsIn, IsNumber, IsOptional, Max, Min } from 'class-validator';

export class TransitionInventoryReservationDto {
  @IsIn(['RELEASED', 'CONSUMED'])
  target_status!: 'RELEASED' | 'CONSUMED';

  // Optional on CONSUMED: omit to issue all remaining reserved quantity.
  // A supplied quantity records a partial issue without closing the reservation.
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  @Max(99999999999999)
  quantity?: number;
}
