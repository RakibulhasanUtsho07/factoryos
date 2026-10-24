import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

export class RegisterEdgePackageSigningKeyDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  key_id!: string;

  @IsString()
  @MaxLength(4096)
  public_key_pem!: string;

  /**
   * Optional overlap rotation: the existing key remains trusted while the new
   * key is registered. Revoke the old key separately after its grace window.
   */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/)
  replaces_key_id?: string;
}
