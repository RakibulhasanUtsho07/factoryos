import { IsString, MaxLength, Matches } from 'class-validator';
export class AcknowledgeSaasBudgetAlertDto {
 @IsString() @MaxLength(128) @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
 idempotency_key!: string;
}
