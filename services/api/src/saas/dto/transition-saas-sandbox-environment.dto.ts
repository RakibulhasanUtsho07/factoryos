import { IsEnum, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export enum SaasSandboxTransitionAction {
  SUSPEND = 'SUSPEND',
  RESUME = 'RESUME',
  RETIRE = 'RETIRE',
}

export class TransitionSaasSandboxEnvironmentDto {
  @IsEnum(SaasSandboxTransitionAction)
  action!: SaasSandboxTransitionAction;

  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  expected_version!: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;

  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
  idempotency_key!: string;
}
