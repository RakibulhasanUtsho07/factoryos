import { IsDateString, IsOptional } from 'class-validator';
export class SupplierPerformanceQueryDto {
  @IsDateString({ strict: true }) from!: string;
  @IsDateString({ strict: true }) to!: string;
  @IsOptional() @IsDateString({ strict: true }) as_of?: string;
}
