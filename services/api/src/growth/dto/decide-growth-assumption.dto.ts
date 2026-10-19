import { ArrayMaxSize, IsArray, IsIn, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator';

export class DecideGrowthAssumptionDto {
  @IsIn(['VALIDATED', 'REFUTED', 'DEFERRED', 'NEEDS_EVIDENCE', 'WAIVED'])
  decision!: 'VALIDATED' | 'REFUTED' | 'DEFERRED' | 'NEEDS_EVIDENCE' | 'WAIVED';

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  reason!: string;

  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(1000, { each: true })
  evidence_refs!: string[];
}
