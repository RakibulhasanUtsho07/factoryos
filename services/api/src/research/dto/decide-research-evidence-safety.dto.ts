import { IsIn, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class DecideResearchEvidenceSafetyDto {
  @IsIn(['CLEAR', 'REJECT'])
  decision!: 'CLEAR' | 'REJECT';

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  reason!: string;
}
