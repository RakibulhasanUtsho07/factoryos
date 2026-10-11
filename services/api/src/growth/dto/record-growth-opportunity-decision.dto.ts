import { IsEnum, IsString, Matches, MaxLength } from 'class-validator';

export enum GrowthOpportunityDecision {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
  DEFERRED = 'DEFERRED',
  WITHDRAWN = 'WITHDRAWN',
}

export class RecordGrowthOpportunityDecisionDto {
  @IsEnum(GrowthOpportunityDecision)
  decision!: GrowthOpportunityDecision;

  @IsString()
  @MaxLength(2000)
  rationale!: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
