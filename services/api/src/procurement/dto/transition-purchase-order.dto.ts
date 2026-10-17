import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

export class TransitionPurchaseOrderDto {
  @IsOptional() @IsInt() @Min(1)
  expected_version?: number;

  @IsOptional() @IsString() @MaxLength(2000)
  reason?: string;
}
