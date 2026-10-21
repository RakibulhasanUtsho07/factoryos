import { IsIn, IsInt, IsString, Length, Min } from 'class-validator';

export class ReviewSaasFinanceRetentionPolicyDto {
  @IsIn(['APPROVE', 'REJECT'])
  decision!: 'APPROVE' | 'REJECT';

  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsString()
  @Length(3, 1000)
  reason!: string;
}
