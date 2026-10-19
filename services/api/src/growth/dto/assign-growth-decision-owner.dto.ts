import { IsIn, IsNotEmpty, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class AssignGrowthDecisionOwnerDto {
  @IsIn(['BUSINESS_OWNER', 'DECISION_OWNER', 'FINANCE_REVIEWER', 'OPERATIONS_REVIEWER', 'QUALITY_REVIEWER', 'RISK_REVIEWER', 'EVIDENCE_OWNER'])
  role_code!: string;

  @IsUUID()
  owner_user_id!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  rationale!: string;
}
