import { IsDateString, IsInt, IsNumber, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
export class ReconcileSaasProviderCostInvoiceDto {
 @IsString() @MaxLength(60) @Matches(/^[a-z][a-z0-9._:-]{0,59}$/) provider_code!: string;
 @IsString() @MaxLength(180) invoice_reference!: string;
 @IsInt() @Min(1) @Max(1000000) reconciliation_version!: number;
 @IsDateString() period_start!: string;
 @IsDateString() period_end!: string;
 @IsString() @Matches(/^[A-Z]{3}$/) currency!: string;
 @IsNumber({allowNaN:false,allowInfinity:false}) @Min(0) @Max(9000000000000000) invoiced_provider_cost_minor!: number;
 @IsString() @MaxLength(128) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/) idempotency_key!: string;
}
