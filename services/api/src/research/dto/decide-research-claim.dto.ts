import { IsIn, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class DecideResearchClaimDto {
  @IsIn(['APPROVE', 'REJECT', 'SUPERSEDE'])
  decision!: 'APPROVE' | 'REJECT' | 'SUPERSEDE';

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;
}
