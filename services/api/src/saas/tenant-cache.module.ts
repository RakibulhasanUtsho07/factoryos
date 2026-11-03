import { Global, Module } from '@nestjs/common';
import { RedisCacheErasureAdapter } from './redis-cache-erasure.adapter';
import { RedisTenantCacheClient } from './redis-tenant-cache.client';
import { TenantCacheService } from './tenant-cache.service';

@Global()
@Module({
  providers: [
    RedisTenantCacheClient,
    TenantCacheService,
    RedisCacheErasureAdapter,
  ],
  exports: [
    TenantCacheService,
    RedisCacheErasureAdapter,
  ],
})
export class TenantCacheModule {}
