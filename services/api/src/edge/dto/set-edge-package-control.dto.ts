import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export enum EdgePackageControlTargetKind {
  FACTORY = 'FACTORY',
  DEVICE = 'DEVICE',
  DEVICE_GROUP = 'DEVICE_GROUP',
  USE_CASE = 'USE_CASE',
}

export enum EdgePackageControlAction {
  PAUSE = 'PAUSE',
  RESUME = 'RESUME',
  REVOKE = 'REVOKE',
}

export class SetEdgePackageControlDto {
  @IsString()
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  package_id!: string;

  /**
   * '*' applies the control to every version. A semantic version limits the
   * control to one signed package release.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  package_version?: string;

  @IsEnum(EdgePackageControlTargetKind)
  target_kind!: EdgePackageControlTargetKind;

  /**
   * FACTORY requires '*'; DEVICE uses its UUID; DEVICE_GROUP and USE_CASE use
   * their stable registered identifier.
   */
  @IsOptional()
  @IsString()
  @MaxLength(128)
  target_key?: string;

  @IsEnum(EdgePackageControlAction)
  action!: EdgePackageControlAction;

  @IsString()
  @MinLength(8)
  @MaxLength(300)
  reason!: string;
}
