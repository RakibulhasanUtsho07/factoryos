import { IsBoolean, IsIn, IsISO8601, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

export class CreateGrowthEvidenceGapDto {
  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(4000)
  question!: string;

  @IsString()
  @IsNotEmpty()
  @MinLength(5)
  @MaxLength(2000)
  required_evidence!: string;

  @IsIn(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'])
  impact!: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

  @IsOptional()
  @IsUUID()
  owner_user_id?: string;

  @IsOptional()
  @IsISO8601()
  due_at?: string;

  @IsOptional()
  @IsBoolean()
  blocks_decision?: boolean;
}
