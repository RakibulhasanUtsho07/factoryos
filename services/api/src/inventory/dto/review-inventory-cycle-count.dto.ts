import {
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class ReviewInventoryCycleCountDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  review_note?: string;
}
