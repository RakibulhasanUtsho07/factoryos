import { IsIn } from 'class-validator';

export class TransitionInventoryReservationDto {
  @IsIn(['RELEASED', 'CONSUMED'])
  target_status!: 'RELEASED' | 'CONSUMED';
}
