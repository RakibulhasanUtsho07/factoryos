import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class EngineeringChangeReviewDto {
  @IsInt() @Min(1)
  expected_version!: number;
  @IsOptional() @IsString() @MaxLength(2000)
  decision_note?: string;
}
