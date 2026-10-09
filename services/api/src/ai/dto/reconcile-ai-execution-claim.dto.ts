import {
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ReconcileAiExecutionClaimDto {
  @IsIn(['CONFIRMED_COMPLETED', 'CONFIRMED_FAILED'])
  decision!: 'CONFIRMED_COMPLETED' | 'CONFIRMED_FAILED';

  @IsString()
  @MinLength(15)
  @MaxLength(1000)
  reason!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(255)
  evidence_ref!: string;
}
