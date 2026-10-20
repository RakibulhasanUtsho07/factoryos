import { IsEnum, IsInt, IsString, Length, Min } from 'class-validator';

export enum SaasTenantErasureReviewDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ReviewSaasTenantErasureRequestDto {
  @IsEnum(SaasTenantErasureReviewDecision)
  decision!: SaasTenantErasureReviewDecision;

  @IsInt()
  @Min(1)
  expected_version!: number;

  @IsString()
  @Length(3, 1000)
  reason!: string;
}
