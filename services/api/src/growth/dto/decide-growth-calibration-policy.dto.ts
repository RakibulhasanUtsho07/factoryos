import { IsIn, IsString, MaxLength, MinLength } from 'class-validator';

export class DecideGrowthCalibrationPolicyDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsString()
  @MinLength(8)
  @MaxLength(1000)
  reason!: string;
}
