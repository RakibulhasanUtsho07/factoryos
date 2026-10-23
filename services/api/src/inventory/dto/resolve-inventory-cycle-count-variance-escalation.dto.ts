import { IsString, MaxLength, MinLength } from 'class-validator';

export class ResolveInventoryCycleCountVarianceEscalationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  resolution_note!: string;
}
