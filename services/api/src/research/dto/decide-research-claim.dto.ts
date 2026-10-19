import { IsIn, IsNotEmpty, IsString, MaxLength, ValidateIf } from 'class-validator';

export class DecideResearchClaimDto {
  @IsIn(['APPROVE', 'REJECT', 'SUPERSEDE'])
  decision!: 'APPROVE' | 'REJECT' | 'SUPERSEDE';

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  reason!: string;

  // An approver, not the source registrant, must assign the final grade on approval.
  @ValidateIf(dto => dto.decision === 'APPROVE')
  @IsIn(['A', 'B', 'C', 'D'])
  evidence_grade?: 'A' | 'B' | 'C' | 'D';
}
