import { IsNumber, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class ConsumeInventoryReservationDto {
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity!: number;
}
