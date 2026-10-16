import {
  IsIn, IsOptional, IsString, MaxLength,
} from 'class-validator';

export class DecideGrowthValidationUnknownDto {
  @IsIn(['START_VALIDATING', 'RESOLVE', 'NOT_MATERIAL'])
  decision!: 'START_VALIDATING' | 'RESOLVE' | 'NOT_MATERIAL';

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  resolution_evidence_ref?: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  resolution_notes?: string;
}
