import { IsDateString, IsNotEmpty, IsNumber, IsOptional, IsString, Length, Max, Min } from 'class-validator';
export class CreateProductVersionDto {
  @IsDateString({ strict: true }) effective_from!: string;
  @IsOptional() @IsDateString({ strict: true }) effective_to?: string | null;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(100) expected_yield_percent!: number;
  @IsString() @IsNotEmpty() @Length(1, 2000) change_summary!: string;
}
