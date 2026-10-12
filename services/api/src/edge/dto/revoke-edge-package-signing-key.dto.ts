import { IsString, MaxLength, MinLength } from 'class-validator';

export class RevokeEdgePackageSigningKeyDto {
  @IsString()
  @MinLength(8)
  @MaxLength(300)
  reason!: string;
}
