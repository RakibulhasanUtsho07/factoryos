import {
  IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID,
  Max, MaxLength, Min,
} from 'class-validator';

export class CreateGrowthValidationUnknownDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(4000)
  question!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  decision_variable!: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  impact_if_wrong!: number;

  @IsNumber()
  @Min(0)
  @Max(1)
  probability_unknown!: number;

  @IsNumber()
  @Min(0.1)
  @Max(100)
  validation_effort!: number;

  @IsIn([
    'MEASURE', 'DOCUMENT_REVIEW', 'CUSTOMER_INTERVIEW',
    'PILOT', 'SUPPLIER_QUOTE', 'MARKET_TEST', 'EXPERT_REVIEW',
  ])
  validation_method!: string;

  @IsOptional()
  @IsUUID()
  owner_user_id?: string;
}
