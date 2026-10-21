import { IsIn, IsString, Length } from 'class-validator';

export class ReviewSaasExternalDataTargetDto {
  @IsIn(['APPROVE', 'REJECT', 'PAUSE', 'RESUME'])
  decision!: 'APPROVE' | 'REJECT' | 'PAUSE' | 'RESUME';

  @IsIn(['PENDING', 'ACTIVE', 'PAUSED'])
  expected_status!: 'PENDING' | 'ACTIVE' | 'PAUSED';

  @IsString()
  @Length(3, 1000)
  reason!: string;
}
